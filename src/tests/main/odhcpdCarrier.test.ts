// The odhcpd restart hook waits for its network's carrier: restarted while
// the bridge had none, odhcpd dropped the interface for good
// (https://github.com/openwrt/odhcpd/issues/423).
import test from "ava";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { join } from "path";
import { compileIntent } from "../../intent/compile";
import { sampleIntent } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const hook = () => {
  const file = compileIntent(sampleIntent()).files.find((f) => f.path === "/etc/hotplug.d/iface/30-odhcpd-ra-fix");
  if (!file) throw new Error("no odhcpd hook in the sample's plan");
  return file.content;
};

/** Runs the hook as netifd would, odhcpd's restart and the tools it calls stubbed. */
const run = (env: Record<string, string>, outcome: "log" | "said") => {
  const dir = tempDir("odhcpd-carrier");
  const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("pidof", "exit 0");
  stub("logger", `echo "$*" >> ${dir}/said`);
  stub("sleep", "true");
  const script = hook()
    .replace(/\/tmp\/onc-/g, `${dir}/onc-`)
    .replace(/\/etc\/init\.d\/odhcpd restart/g, `echo restarted >> ${dir}/log`);
  spawnSync("sh", ["-c", `${script}\nwait`], { env: { PATH: `${dir}:/usr/bin:/bin`, ACTION: "ifup", INTERFACE: "lan", ...env } });
  // Backgrounded: wait for the outcome the test expects (the restart, or
  // the word why not), then a moment for anything else it would do.
  const until = Date.now() + 10_000;
  while (!existsSync(join(dir, outcome)) && Date.now() < until) spawnSync("sleep", ["0.05"]);
  spawnSync("sleep", ["0.3"]);
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8") : "");
  return { restarted: read("log").includes("restarted"), said: read("said") };
};

test("a network up on a device with no carrier leaves odhcpd alone, and says why", (t) => {
  const { restarted, said } = run({ DEVICE: "onc-test-no-such-device" }, "said");
  t.false(restarted);
  t.regex(said, /without carrier on onc-test-no-such-device/);
});

test("with no device named (netifd always gives one), it restarts as before", (t) => {
  t.true(run({}, "log").restarted);
});
