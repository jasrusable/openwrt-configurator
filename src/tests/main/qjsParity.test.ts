import test from "ava";
import { spawnSync } from "child_process";
import { createHash } from "crypto";
import { buildSync } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parityReport } from "../helpers/parityReport";

// The same code under Node and QuickJS must behave identically. Skipped where
// qjs is not installed; everything here is offline.
const hasQjs = spawnSync("sh", ["-c", "command -v qjs"]).status === 0;
const qjsTest = hasQjs ? test : test.skip;

const root = join(__dirname, "../../..");
const work = mkdtempSync(join(tmpdir(), "onc-parity-"));
test.after.always(() => rmSync(work, { recursive: true, force: true }));

const bundle = (entry: string, platform: "node" | "neutral") => {
  const outfile = join(
    work,
    `${entry.replace(/\W/g, "_")}.${platform === "node" ? "cjs" : "mjs"}`
  );
  buildSync({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: platform === "node" ? "cjs" : "esm",
    platform,
    mainFields: ["main", "module"],
    // node-ssh pulls in native modules esbuild cannot bundle; NODE_PATH finds it.
    external: platform === "node" ? ["node-ssh"] : ["std", "os"],
    outfile,
    logLevel: "error",
  });
  return outfile;
};

const run = (command: string[], args: string[]) => {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: join(root, "node_modules") },
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
      // sha256 of "image bytes\n"
      sha256:
        "b4c0b5e2f5bf5be7c1ea4ae30c1d2ff9a2a9e1c7d3b4f51bd5d9e0e1f9fa6f1a",
      devices: [{ hostname: "r1" }],
    },
    {
      filename: "bad.bin",
      sha256: "0".repeat(64),
      devices: [{ hostname: "r2" }],
    },
  ])
);

const cases: [string, string[]][] = [
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
];

for (const [name, args] of cases) {
  qjsTest(`cli: ${name}`, (t) => {
    t.deepEqual(run(cli!.qjs, args), run(cli!.node, args));
  });
}

qjsTest("pipeline output for the fixtures", async (t) => {
  // The fixtures' plaintext-key warnings are expected; keep them out of the log.
  const warn = console.warn;
  console.warn = () => {};
  const expected = await parityReport().finally(() => (console.warn = warn));
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
