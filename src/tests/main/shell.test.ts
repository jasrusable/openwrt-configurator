import test from "ava";
import { tempDir } from "../helpers/tempDir";
import { spawnSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { getDeviceScript } from "../../getDeviceScript";
import { getUciCommands } from "../../getUciCommands";
import { oncConfigSchema } from "../../oncConfigSchema";
import { shellQuote } from "../../shell";

const hostile = [
  "Jason's WiFi",
  'say "hi"',
  "$(touch PWNED)",
  "`touch PWNED`",
  "a; touch PWNED",
  "two\nlines",
  "back\\slash",
  "",
  "'",
];

test("shellQuote round-trips every hostile string through a real sh", (t) => {
  const dir = tempDir("shell");
  for (const value of hostile) {
    const out = spawnSync("sh", ["-c", `printf %s ${shellQuote(value)}`], {
      cwd: dir,
      encoding: "utf8",
    });
    t.is(out.stdout, value, JSON.stringify(value));
  }
  t.false(existsSync(join(dir, "PWNED")), "nothing was executed");
});

test("UCI values are quoted the way uci batch accepts", (t) => {
  const commands = getUciCommands({
    openWrtConfig: {
      wireless: { "wifi-iface": [{ ".name": "w", ssid: "Jason's WiFi" }] },
    } as any,
  });
  t.true(commands.includes(`uci set wireless.w.ssid='Jason'\\''s WiFi'`));
});

test("UCI names that cannot be quoted are rejected with a clear error", (t) => {
  const run = (config: object) => () =>
    getUciCommands({ openWrtConfig: config as any });
  t.throws(run({ sqm: { queue: [{ ".name": "q", "bad option": "x" }] } }), {
    message: /Invalid UCI option name "bad option"/,
  });
  t.throws(run({ "my pkg": { s: [{ ".name": "q" }] } }), {
    message: /Invalid UCI package name "my pkg"/,
  });
  t.notThrows(
    run({ wireless: { "wifi-iface": [{ ".name": "w", ssid: "x" }] } })
  );
});

test("a file with a hostile path is written exactly, by a real sh", (t) => {
  const dir = tempDir("files");
  const path = join(dir, "it's $(touch PWNED); a`b`\nc");
  const commands = getDeviceScript({
    state: {
      config: {} as any,
      files: [{ path, content: "x'y $(z)\n", mode: "0600" }],
    },
  });
  // Only this file's write: its mkdir line names the test dir. The manifest
  // lists the path in its content, but goes to /etc/onc on a device.
  const writes = commands.filter(
    (c) => c.includes("cat >") && c.split("\n")[0].includes(dir)
  );
  const result = spawnSync("sh", ["-c", writes.join("\n")], {
    cwd: dir,
    encoding: "utf8",
  });
  t.is(result.status, 0, result.stderr);
  t.is(readFileSync(path, "utf8"), "x'y $(z)\n");
  t.false(existsSync(join(dir, "PWNED")), "nothing was executed");
});

test("package names, file modes and paths are validated up front", (t) => {
  const parse = (extra: object) => () =>
    oncConfigSchema.parse({ devices: [], config: {}, ...extra });
  t.notThrows(
    parse({
      package_profiles: [
        { packages: ["luci-app-sqm", "-firewall4", "libstdcpp6"] },
      ],
    })
  );
  t.throws(parse({ package_profiles: [{ packages: ["sqm; reboot"] }] }));
  t.throws(
    parse({ files: [{ path: "/etc/x", content: "", mode: "755; reboot" }] })
  );
  t.throws(parse({ files: [{ path: "etc/x", content: "" }] }));
});
