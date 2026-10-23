// The https-dns-proxy restart hook: an internet line coming up stops and
// starts the proxies (the package's own trigger only reloads, which procd
// leaves running as they were); a line and its IPv6 together, once.
import test from "ava";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { join } from "path";
import { compileIntent } from "../../intent/compile";
import { sampleIntent } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const hook = () => {
  const file = compileIntent(sampleIntent()).files.find((f) => f.path === "/etc/hotplug.d/iface/40-onc-doh-restart");
  if (!file) throw new Error("no https-dns-proxy hook in the sample's plan");
  return file.content;
};

/** Runs the hook as netifd would, once per event at the same moment, the init script and logger stubbed. */
const run = (events: Record<string, string>[]) => {
  const dir = tempDir("doh-restart");
  const stub = (name: string, body: string) => writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub("logger", "true");
  stub("sleep", "/bin/sleep 0.3");
  stub("https-dns-proxy", `[ "$1" = enabled ] || echo "$1" >> ${dir}/log`);
  const script = hook().replace(/\/tmp\/onc-/g, `${dir}/onc-`).replace(/\/etc\/init\.d\/https-dns-proxy/g, `${dir}/https-dns-proxy`);
  const runs = events.map(
    (env) =>
      new Promise<void>((resolve) =>
        spawn("sh", ["-c", `${script}\nwait`], { env: { PATH: `${dir}:/usr/bin:/bin`, ...env } }).on("exit", () => resolve())
      )
  );
  return Promise.all(runs).then(() => {
    spawnSync("sleep", ["0.2"]);
    return existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8").trim().split("\n") : [];
  });
};

test("a line coming up stops and starts the proxies", async (t) => {
  t.deepEqual(await run([{ ACTION: "ifup", INTERFACE: "wan" }]), ["stop", "start"]);
});

test("a line and its IPv6 up together restart them once", async (t) => {
  t.deepEqual(
    await run([
      { ACTION: "ifup", INTERFACE: "wan" },
      { ACTION: "ifup", INTERFACE: "wan6" },
    ]),
    ["stop", "start"]
  );
});

test("a network of the house coming up, or a line going down, leaves them alone", async (t) => {
  t.deepEqual(await run([{ ACTION: "ifup", INTERFACE: "lan" }]), []);
  t.deepEqual(await run([{ ACTION: "ifdown", INTERFACE: "wan" }]), []);
});

test("the shell reads the hook", (t) => {
  t.is(spawnSync("sh", ["-n", "-c", hook()]).status, 0);
});
