import test from "ava";
import { tempDir } from "../helpers/tempDir";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { encodeRecords } from "../../agent/records";
import { agentScript } from "../../agent/script";
import { stageRecords } from "../../getDeviceScript";
import { getUciCommands } from "../../engine/getUciCommands";
import { shellQuote } from "../../shell";
import { planOf, stateOf } from "../helpers/fixtures";

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

test("a file with a hostile path or content is written exactly by the agent, under a real sh, and nothing runs", (t) => {
  const dir = tempDir("files");
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  const path = "/it's $(touch PWNED); a`b`c";
  const content = "x'y $(z) `w`\n";
  const records = stageRecords({ state: stateOf({ files: [{ path, content, mode: "0600" }] }), current: {} }).filter(
    (r) => r.kind === "write" && r.path === path
  );
  const agent = join(tmp, "onc-agent-t.sh");
  writeFileSync(agent, agentScript);
  const env = { ...process.env, ONC_ROOT: dir, ONC_TMP: tmp };
  t.is(spawnSync("sh", [agent, "begin"], { env, cwd: dir }).status, 0);
  const result = spawnSync("sh", [agent, "stage"], { env, cwd: dir, input: encodeRecords(records), encoding: "utf8" });
  t.is(result.status, 0, result.stderr);
  t.is(readFileSync(join(dir, path), "utf8"), content);
  t.false(existsSync(join(dir, "PWNED")), "nothing was executed");
  // A line break would split the agent's records: refused before it is sent.
  t.throws(() => encodeRecords([{ kind: "write", path: "/a\nb", mode: "0644", content: "x" }]), { message: /one line/ });
});

test("package names, file modes and paths are validated up front", (t) => {
  const parse = (extra: object) => () =>
    planOf({ devices: [], config: {}, ...extra });
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
