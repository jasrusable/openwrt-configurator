import test from "ava";
import { tempDir } from "../helpers/tempDir";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { buildSync } from "esbuild";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { parityReport } from "../helpers/parityReport";
import { nodePlatform } from "../../platforms/node";

// The same code under Node and QuickJS must behave identically. Skipped where
// qjs is not installed; everything here is offline.
const hasQjs = spawnSync("sh", ["-c", "command -v qjs"]).status === 0;
const qjsTest = hasQjs ? test : test.skip;

// Skipping is for machines without qjs. CI installs it, so its absence there
// means the parity check silently stopped running.
if (process.env.CI && !hasQjs) {
  test("qjs is installed in CI", (t) => {
    t.fail("qjs not found on PATH; see scripts/install-quickjs.sh");
  });
}

const root = join(__dirname, "../../..");
const work = tempDir("parity");

// The QuickJS side is built exactly as `npm run bundle` builds it.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { bundleForQjs } = require("../../../scripts/bundle.js");

const bundle = (entry: string, platform: "node" | "neutral") => {
  const outfile = join(
    work,
    `${entry.replace(/\W/g, "_")}.${platform === "node" ? "cjs" : "mjs"}`
  );
  if (platform === "neutral") {
    bundleForQjs(join(root, entry), outfile);
    return outfile;
  }
  buildSync({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: "cjs",
    platform: "node",
    // Same reason as scripts/bundle.js: jsonc-parser's UMD `main` cannot be bundled.
    mainFields: ["module", "main"],
    // node-ssh pulls in native modules esbuild cannot bundle; NODE_PATH finds it.
    external: ["node-ssh"],
    outfile,
    logLevel: "error",
  });
  return outfile;
};

const run = (command: string[], args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: join(root, "node_modules"), ...env },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
};

const cli = hasQjs
  ? {
      node: ["node", bundle("bin/index.ts", "node")],
      qjs: ["qjs", "--module", bundle("bin/qjs.ts", "neutral")],
    }
  : undefined;

const broken = join(work, "broken.json");
writeFileSync(broken, '{\n  "devices": [\n    { "hostname": "r1", }\n  ]\n}\n');
const images = join(work, "images");
mkdirSync(images);
writeFileSync(join(images, "good.bin"), "image bytes\n");
writeFileSync(join(images, "bad.bin"), "image bytes\n");
writeFileSync(
  join(images, "manifest.json"),
  JSON.stringify([
    {
      filename: "good.bin",
      sha256: createHash("sha256").update("image bytes\n").digest("hex"),
      devices: [{ hostname: "r1" }],
    },
    {
      filename: "bad.bin",
      sha256: "0".repeat(64),
      devices: [{ hostname: "r2" }],
    },
  ])
);

// What uhttpd runs on a router: one request per process, from CGI variables.
const ui = join(work, "ui");
mkdirSync(ui);
writeFileSync(join(ui, "index.html"), "<!doctype html><title>onc</title>\n");
const cgi = (path: string): Record<string, string> => ({
  REQUEST_METHOD: "GET",
  PATH_INFO: path,
  HTTP_X_ONC: "1",
  REMOTE_ADDR: "10.254.0.9",
});
const cgiArgs = ["cgi", "sampleConfigs/intent.json", "--ui-dir", ui];

const cases: [string, string[], Record<string, string>?][] = [
  ["help", ["--help"]],
  ["version", ["--version"]],
  ["command help", ["provision", "--help"]],
  ["missing subcommand", ["secrets"]],
  ["unknown command", ["nope"]],
  ["missing argument", ["provision"]],
  ["invalid option value", ["provision", "x.json", "--rollback", "sideways"]],
  ["missing config file", ["build-images", "does-not-exist.json", "--dry-run"]],
  ["broken JSON", ["build-images", broken, "--dry-run"]],
  [
    "config without a version",
    ["build-images", "src/tests/main/config.json", "--dry-run"],
  ],
  ["verify-images", ["verify-images", "--out", images]],
  ["compile an intent", ["compile", "sampleConfigs/intent.json"]],
  ["cgi: the UI's page", cgiArgs, cgi("/")],
  ["cgi: the API without a login", cgiArgs, cgi("/api/intent")],
];

for (const [name, args, env] of cases) {
  qjsTest(`cli: ${name}`, (t) => {
    t.deepEqual(run(cli!.qjs, args, env), run(cli!.node, args, env));
  });
}

qjsTest("pipeline output for the fixtures", async (t) => {
  // The fixtures' plaintext-key warnings are expected; keep them out of the log.
  const warn = console.warn;
  console.warn = () => {};
  const expected = await parityReport({ platform: nodePlatform }).finally(
    () => (console.warn = warn)
  );
  const actual = run(
    [
      "qjs",
      "--module",
      bundle("src/tests/helpers/qjsParityEntry.ts", "neutral"),
    ],
    []
  );
  t.is(actual.status, 0, actual.stderr);
  t.is(actual.stdout.trimEnd(), expected);
});

qjsTest("session layer over the local transport", (t) => {
  const actual = run(
    [
      "qjs",
      "--module",
      bundle("src/tests/helpers/qjsSessionEntry.ts", "neutral"),
    ],
    []
  );
  t.is(actual.status, 0, actual.stderr);
  const lines = actual.stdout.trim().split("\n");
  t.deepEqual(
    lines.filter((line) => !line.startsWith("PASS")),
    []
  );
  t.is(lines.length, 8);
});
