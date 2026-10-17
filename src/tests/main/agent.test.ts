// The device side of commit-confirm (src/agent/script.ts), run for real under
// plain sh in a temp dir: OpenWrt's commands (uci, apk, ubus, reload_config,
// reboot, ...) are stubs that log what they were asked, /etc and /tmp live
// under ONC_ROOT and ONC_TMP, and the watchdog is a real background process.
import test from "ava";
import { execFile, spawnSync } from "child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { AgentRecord, decodeRecords, encodeRecords } from "../../agent/records";
import { stateOf } from "../helpers/fixtures";
import { agentScript, bootScript } from "../../agent/script";
import { appliedKeepList, appliedMarker } from "../../agent/paths";
import { tempDir } from "../helpers/tempDir";

const stub = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
};

/** A device: /etc with a config, a boot link and a service; stubs on PATH; the agent written. */
const device = () => {
  const base = tempDir("agent");
  const root = join(base, "root");
  const tmp = join(base, "tmp");
  const bin = join(base, "bin");
  const state = join(base, "state");
  for (const dir of [`${root}/etc/config`, `${root}/etc/rc.d`, `${root}/etc/init.d`, tmp, bin, `${state}/running`]) mkdirSync(dir, { recursive: true });
  writeFileSync(`${root}/etc/config/network`, "config interface 'lan'\n");
  writeFileSync(`${root}/etc/old`, "before\n");
  symlinkSync("../init.d/svc", `${root}/etc/rc.d/S50svc`);
  const log = join(base, "log");
  writeFileSync(log, "");
  const say = `echo "$(basename "$0") $*" >> "${log}"`;
  for (const name of ["logger", "reload_config", "wifi", "reboot", "sync"]) stub(bin, name, say);
  stub(bin, "setsid", 'exec "$@"');
  // uci: what it was asked, a batch's operations kept, a batch with FAIL in
  // it complaining on stderr (as uci does, exiting 0), a commit that can fail.
  stub(
    bin,
    "uci",
    `${say}\ncase "$1" in\n changes) cat "${state}/uci-changes" 2>/dev/null ;;\n batch) cat >> "${state}/batch"; grep -q FAIL "${state}/batch" && echo "uci: Parse error (invalid command) at line 1" >&2 ;;\n commit) [ -f "${state}/fail-commit" ] && exit 1 ;;\nesac\ntrue`
  );
  stub(bin, "apk", `${say}\nif [ "$1" = fetch ]; then shift 2; d="$1"; shift; for p in "$@"; do : > "$d/$p.apk"; done; fi`);
  // procd's service list: a running service is a top-level key.
  stub(bin, "ubus", `n=$(echo "$4" | sed 's/.*"name":"\\([^"]*\\)".*/\\1/'); [ -f "${state}/running/$n" ] && printf '{\\n\\t"%s": {}\\n}\\n' "$n"; true`);
  for (const name of ["svc", "other"]) {
    stub(`${root}/etc/init.d`, name, `${say}\ncase "$1" in start) : > "${state}/running/${name}" ;; stop) rm -f "${state}/running/${name}" ;; esac`);
  }
  const runId = "t1";
  const agent = join(tmp, `onc-agent-${runId}.sh`);
  writeFileSync(agent, agentScript);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ONC_ROOT: root, ONC_TMP: tmp };
  // Async: a synchronous spawn would stall every other test's polling (and so
  // their watchdogs' timing) for as long as a verb waits on its own.
  const call = (input: string, args: string[]) =>
    new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      const child = execFile("sh", [agent, ...args], { env, encoding: "utf8", timeout: 20_000 }, (error, stdout, stderr) =>
        error && error.code === undefined ? reject(error) : resolve({ stdout, stderr })
      );
      // A verb that exits without reading its input closes the pipe first:
      // the write then fails with EPIPE, which its exit status already says.
      child.stdin!.on("error", () => {});
      child.stdin!.end(input);
    });
  const run = (...args: string[]) => call("", args).then((r) => r.stdout);
  /** A step verb with its records, as the engine sends them; `fail: "uci commit"` makes commits fail. */
  const steps = async (verb: string, records: AgentRecord[], { fail }: { fail?: "uci commit" } = {}) => {
    if (fail) writeFileSync(join(state, "fail-commit"), "");
    try {
      return await call(encodeRecords(records), [verb]);
    } finally {
      rmSync(join(state, "fail-commit"), { force: true });
    }
  };
  /** Arm, its lists on stdin as the engine sends them ("<list> <item>" a line each). */
  const arm = (lists: string[], ...options: string[]) => call(lists.map((line) => `${line}\n`).join(""), ["arm", ...options]);
  const runDir = join(tmp, `onc-run-${runId}`);
  return { root, tmp, bin, state, runDir, agent, run, arm, steps, call, log: () => readFileSync(log, "utf8"), base };
};

const until = async (what: () => boolean, ms = 30_000) => {
  const end = Date.now() + ms;
  while (!what()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
};

/** The change an apply makes: config, a new file, an old one changed, a boot link gone, staged uci. */
const change = (d: ReturnType<typeof device>) => {
  writeFileSync(`${d.root}/etc/config/network`, "config interface 'wan'\n");
  writeFileSync(`${d.root}/etc/new`, "made by the run\n");
  writeFileSync(`${d.root}/etc/old`, "after\n");
  rmSync(`${d.root}/etc/rc.d/S50svc`);
  writeFileSync(`${d.state}/uci-changes`, "network.lan.proto='dhcp'\n");
};

/** Armed, and the apply's change made at once (a short window fires soon). */
const armed = async (d: ReturnType<typeof device>, ...options: string[]) => {
  if (!(await d.run("begin")).includes("ONC_BEGUN")) throw new Error("begin");
  const out = await d.arm([], ...options);
  if (!out.stdout.includes("ONC_ARMED")) throw new Error(`arm: ${out.stdout}${out.stderr}`);
  expectSleeping(d);
  change(d);
};

/** Armed means its watchdog sleeps: the arm says so only then. */
const expectSleeping = (d: ReturnType<typeof device>) => {
  if (!existsSync(join(d.runDir, "sleep.pid"))) throw new Error("armed before its watchdog slept");
};

const onc = (dir: string) => readdirSync(dir).filter((name) => name.startsWith("onc-"));

test("armed, then disarmed and done: the config stays, marked applied for an upgrade to keep, and nothing is left behind", async (t) => {
  const d = device();
  await armed(d, "--timeout", "30", "--mode", "reload");
  t.false(existsSync(`${d.root}${appliedMarker}`), "not applied until confirmed");
  t.true(existsSync(`${d.root}/etc/onc/rollback/t1/config/network`), "a boot-time copy on flash");
  t.true(lstatSync(`${d.root}/etc/rc.d/S11onc-rollback`).isSymbolicLink(), "its boot script enabled");
  await d.steps("finalise", [{ kind: "commit", config: "network" }]);
  t.true((await d.run("disarm")).includes("ONC_DISARMED"));
  t.true((await d.run("disarm")).includes("ONC_DISARMED"), "a disarm repeated after one that went through");
  t.true((await d.run("done")).includes("ONC_DONE"));
  t.deepEqual(onc(d.tmp), []);
  t.false(existsSync(`${d.root}/etc/onc/rollback`), "a restart keeps the confirmed config");
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'wan'\n");
  t.notRegex(d.log(), /uci revert|^reboot/m, "no restore");
  // An image's first-boot defaults leave this device's settings alone after an upgrade that keeps them.
  t.true(existsSync(`${d.root}${appliedMarker}`));
  t.is(readFileSync(`${d.root}${appliedKeepList}`, "utf8"), `${appliedMarker}\n`);
});

test("a device the run never committed on is disarmed unmarked: its settings are not this app's for that", async (t) => {
  const d = device();
  await armed(d, "--timeout", "30");
  t.true((await d.run("disarm")).includes("ONC_DISARMED"));
  t.true((await d.run("done")).includes("ONC_DONE"));
  t.false(existsSync(`${d.root}${appliedMarker}`));
});

test("asleep: the seconds before it fires; a watchdog that died asleep leaves the change kept, and a disarm says so", async (t) => {
  const d = device();
  await armed(d, "--timeout", "30");
  t.regex(await d.run("asleep"), /^ONC_ASLEEP (29|30)$/m);
  await d.steps("finalise", [{ kind: "commit", config: "network" }]);
  // Killed asleep (out of memory, say): nothing will restore the change.
  process.kill(Number(readFileSync(join(d.runDir, "watchdog.pid"), "utf8")), "SIGKILL");
  process.kill(Number(readFileSync(join(d.runDir, "sleep.pid"), "utf8")), "SIGKILL");
  t.regex(await d.run("asleep"), /^ONC_KEPT$/m);
  t.true((await d.run("disarm")).includes("ONC_DISARMED"), "not fired: nothing was restored");
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'wan'\n");
  t.true(existsSync(`${d.root}${appliedMarker}`));
  t.false(existsSync(`${d.root}/etc/onc/rollback`), "a restart keeps it too");
  await d.run("done");
});

test("rolled back now after its watchdog died asleep: a new one restores at once", async (t) => {
  const d = device();
  await armed(d, "--timeout", "30", "--mode", "reload", "--recover", "1");
  process.kill(Number(readFileSync(join(d.runDir, "watchdog.pid"), "utf8")), "SIGKILL");
  process.kill(Number(readFileSync(join(d.runDir, "sleep.pid"), "utf8")), "SIGKILL");
  t.true((await d.run("rollback-now")).includes("ONC_WOKEN"));
  await until(() => !existsSync(d.agent));
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'lan'\n");
});

test("a wedged system log (logger never returns) cannot stall a rollback", async (t) => {
  const d = device();
  // A logd whose socket is full blocks every writer, as this logger does.
  stub(d.bin, "logger", `echo "logger $*" >> "${d.base}/log"; exec sleep 30`);
  await d.run("begin");
  t.true((await d.arm(["restore /etc/old"], "--timeout", "1", "--mode", "reload", "--recover", "1")).stdout.includes("ONC_ARMED"));
  writeFileSync(`${d.root}/etc/old`, "changed\n");
  const started = Date.now();
  await until(() => !existsSync(d.agent), 30_000);
  t.is(readFileSync(`${d.root}/etc/old`, "utf8"), "before\n", "restored all the same");
  t.true(Date.now() - started < 20_000, `took ${Date.now() - started} ms`);
});

test("not confirmed in time: config, files, packages, boot links, services and staged changes restored, in order", async (t) => {
  const d = device();
  writeFileSync(`${d.state}/running/svc`, "");
  writeFileSync(`${d.root}/etc/a b's`, "spaces and a quote\n");
  await d.run("begin");
  t.regex(await d.run("stage-packages", "luci-ssl", "uhttpd"), /ONC_STAGED\s+2/);
  const lists = ["delete /etc/new", "restore /etc/old", "restore /etc/missing", "restore /etc/a b's", "new-package nlbwmon", "service svc", "service other", "restart svc"];
  t.true((await d.arm(lists, "--timeout", "2", "--mode", "reload", "--recover", "2", "--wireless")).stdout.includes("ONC_ARMED"));
  change(d);
  writeFileSync(`${d.root}/etc/a b's`, "changed\n");
  rmSync(`${d.state}/running/svc`);
  writeFileSync(`${d.state}/running/other`, "");
  await until(() => !existsSync(d.agent), 30_000);
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'lan'\n");
  t.false(existsSync(`${d.root}/etc/new`), "a file the run made is gone");
  t.is(readFileSync(`${d.root}/etc/old`, "utf8"), "before\n", "one it changed is as it was");
  t.is(readFileSync(`${d.root}/etc/a b's`, "utf8"), "spaces and a quote\n", "a path with spaces and a quote, whole");
  t.true(lstatSync(`${d.root}/etc/rc.d/S50svc`).isSymbolicLink(), "boot links as they were");
  t.true(lstatSync(`${d.root}/etc/rc.d/S11onc-rollback`).isSymbolicLink(), "its own boot script's link too: taken before rc.d was copied");
  const log = d.log();
  const at = (text: string) => log.indexOf(text);
  t.true(at("uci revert network") > -1 && at("uci revert network") < at("apk del nlbwmon"), "staged changes dropped before any package step");
  t.true(at("apk del nlbwmon") < at("apk add --allow-untrusted --repositories-file /dev/null"), "new packages out before old ones back");
  t.true(at("apk add") < at("reload_config"));
  t.true(at("reload_config") < at("wifi reload"), "wireless reloaded after the config");
  t.regex(log, /svc start/, "a service that ran is running again");
  t.regex(log, /other stop/, "one that did not is stopped again");
  t.true(at("svc start") < at("svc restart"), "restarted once the restored config is live");
  t.notRegex(log, /^reboot/m, "--rollback=reload never reboots");
  t.regex(log, /forbids rebooting/);
  t.deepEqual(onc(d.tmp), [], "it cleans up after itself");
});

test("rolled back now: restored at once, and told it recovered only once restored", async (t) => {
  const d = device();
  await armed(d, "--timeout", "60", "--mode", "reload-then-reboot", "--recover", "10");
  t.false((await d.run("recovered")).includes("ONC_RECOVERED"), "not before its restore: it is still on the new config");
  t.true((await d.run("rollback-now")).includes("ONC_WOKEN"));
  await until(() => existsSync(join(d.runDir, "restored")));
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'lan'\n");
  t.true((await d.run("recovered")).includes("ONC_RECOVERED"));
  await until(() => !existsSync(d.agent));
  t.regex(d.log(), /revert restored access, no reboot needed/);
  t.notRegex(d.log(), /^reboot/m);
  t.deepEqual(onc(d.tmp), []);
});

test("a disarm that comes once the restore has started says it fired, and never stops it", async (t) => {
  const d = device();
  await armed(d, "--timeout", "2", "--mode", "reload", "--recover", "3");
  await until(() => existsSync(join(d.runDir, "restored")));
  t.true((await d.run("disarm")).includes("ONC_FIRED"));
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'lan'\n");
  await until(() => !existsSync(d.agent));
});

test("reboot mode: boot links back, then a reboot, no reload", async (t) => {
  const d = device();
  await armed(d, "--timeout", "2", "--mode", "reboot");
  await until(() => /^reboot/m.test(d.log()));
  t.true(lstatSync(`${d.root}/etc/rc.d/S50svc`).isSymbolicLink());
  t.notRegex(d.log(), /reload_config/);
});

test("a failed arm, and a dropped one, leave nothing: no snapshot to restore at a later boot, no watchdog", async (t) => {
  const d = device();
  await d.run("begin");
  t.false((await d.arm([], "--bogus")).stdout.includes("ONC_ARMED"));
  t.false((await d.arm(["bogus /etc/x"])).stdout.includes("ONC_ARMED"), "an unknown list");
  t.true((await d.run("drop")).includes("ONC_DROPPED"));
  t.deepEqual(onc(d.tmp), []);

  const e = device();
  await armed(e, "--timeout", "30");
  const watchdog = Number(readFileSync(join(e.runDir, "watchdog.pid"), "utf8"));
  t.true((await e.run("drop")).includes("ONC_DROPPED"));
  t.deepEqual(onc(e.tmp), []);
  t.false(existsSync(`${e.root}/etc/onc/rollback/t1`));
  t.throws(() => process.kill(watchdog, 0), undefined, "its watchdog stood down");
  t.notRegex(e.log(), /reload_config/);
});

test("a device restarted inside the window boots its old config, files and boot links back", async (t) => {
  const d = device();
  await d.run("begin");
  t.true((await d.arm(["delete /etc/new", "restore /etc/old"], "--timeout", "30")).stdout.includes("ONC_ARMED"));
  change(d);
  // The restart: the boot script, as procd runs it early at boot.
  const boot = spawnSync("sh", ["-c", `. "${d.root}/etc/init.d/onc-rollback"; boot`], { env: { ...process.env, ONC_ROOT: d.root }, encoding: "utf8" });
  t.is(boot.status, 0);
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'lan'\n");
  t.false(existsSync(`${d.root}/etc/new`), "a file the run made is gone");
  t.is(readFileSync(`${d.root}/etc/old`, "utf8"), "before\n", "one it changed is as it was");
  t.true(lstatSync(`${d.root}/etc/rc.d/S50svc`).isSymbolicLink(), "boot links as they were");
  t.false(existsSync(`${d.root}/etc/onc/rollback`));
  await d.run("drop");
});

test("the commit's marker: there only once finalise has committed", async (t) => {
  const d = device();
  await d.run("begin");
  t.false((await d.run("commit-finished")).includes("ONC_COMMITTED"));
  const refused = await d.steps("finalise", [{ kind: "commit", config: "network" }], { fail: "uci commit" });
  t.notRegex(refused.stdout, /ONC_OK/);
  t.false((await d.run("commit-finished")).includes("ONC_COMMITTED"), "a commit that failed is no commit");
  // Written after the reload, nothing said between: a verb ended by its last
  // write (the link gone) has not reloaded, and must not pass for committed.
  stub(d.bin, "reload_config", `[ -f "${d.runDir}/committed" ] && echo "reload_config after the marker" >> "${d.base}/log"; true`);
  await d.steps("finalise", [{ kind: "commit", config: "network" }]);
  t.true((await d.run("commit-finished")).includes("ONC_COMMITTED"));
  t.notRegex(d.log(), /after the marker/);
});

test("every verb leaves the SSH session's cgroup for the agent's own, or the root one, so procd can always restart dropbear", async (t) => {
  const d = device();
  const cg = `${d.root}/sys/fs/cgroup`;
  mkdirSync(cg, { recursive: true });
  writeFileSync(`${cg}/cgroup.procs`, "");
  await d.run("begin");
  t.regex(readFileSync(`${cg}/onc/cgroup.procs`, "utf8"), /^\d+\n$/, "into its own cgroup");
  // Where its own cannot be made, the root one.
  rmSync(`${cg}/onc`, { recursive: true });
  writeFileSync(`${cg}/onc`, "not a directory");
  await d.run("begin");
  t.regex(readFileSync(`${cg}/cgroup.procs`, "utf8"), /^\d+\n$/);
});

test("the agent is one fixed script: no run's values in it", async (t) => {
  t.notRegex(agentScript, /\$\{(?!ONC_ROOT|ONC_TMP|AGENT|RUN|line|rest|h[#%]|c#|v%|w%|n1?\}|f\})[a-z]/i, "only its own shell variables");
  t.false(agentScript.includes("\nONC_AGENT_EOF\n"));
});

test("a snapshot that cannot be taken whole (a /tmp full of staged packages) fails the arm: no watchdog, nothing to restore", async (t) => {
  const d = device();
  // cp fails for the boot links' copy, as on a full /tmp.
  writeFileSync(join(d.bin, "cp"), `#!/bin/sh\ncase "$*" in *rc.d*) echo "cp: No space left on device" >&2; exit 1 ;; esac\nexec /bin/cp "$@"\n`);
  chmodSync(join(d.bin, "cp"), 0o755);
  await d.run("begin");
  const out = await d.arm(["restore /etc/old"], "--timeout", "2");
  t.false(out.stdout.includes("ONC_ARMED"));
  t.regex(out.stderr, /could not snapshot/);
  t.false(existsSync(join(d.runDir, "watchdog.pid")), "no watchdog started");
  t.false(existsSync(`${d.root}/etc/onc/rollback/t1`), "no boot-time copy");
  t.true((await d.run("drop")).includes("ONC_DROPPED"));
  t.deepEqual(onc(d.tmp), []);
});

test("a watchdog whose run was taken away while it slept restores nothing, reloads nothing, reboots nothing", async (t) => {
  const d = device();
  await armed(d, "--timeout", "1", "--mode", "reload-then-reboot");
  const watchdog = Number(readFileSync(join(d.runDir, "watchdog.pid"), "utf8"));
  rmSync(d.runDir, { recursive: true, force: true });
  await until(() => {
    try {
      return !process.kill(watchdog, 0);
    } catch {
      return true;
    }
  });
  t.notRegex(d.log(), /reload_config|^reboot|uci revert/m);
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'wan'\n", "the change stays");
});

test("a drop while the watchdog is restoring leaves it its run; rollback-now says woken only when it woke something", async (t) => {
  const d = device();
  await d.run("begin");
  t.is((await d.run("rollback-now")).trim(), "", "nothing asleep, nothing restoring: not woken");
  await armed(d, "--timeout", "1", "--mode", "reload", "--recover", "8");
  await until(() => existsSync(join(d.runDir, "restored")));
  t.false((await d.run("drop")).includes("ONC_DROPPED"), "its watchdog still waits to hear access is back");
  t.true(existsSync(d.runDir));
  t.true((await d.run("rollback-now")).includes("ONC_WOKEN"), "already restoring counts");
  t.true((await d.run("recovered")).includes("ONC_RECOVERED"));
  await until(() => !existsSync(d.agent));
});

test("restarted with several runs' copies on flash: the oldest is the config before any of them", async (t) => {
  const d = device();
  const copy = (run: string, content: string, mtime: number) => {
    mkdirSync(`${d.root}/etc/onc/rollback/${run}/config`, { recursive: true });
    writeFileSync(`${d.root}/etc/onc/rollback/${run}/config/network`, content);
    utimesSync(`${d.root}/etc/onc/rollback/${run}`, mtime, mtime);
  };
  copy("newer", "config interface 'middle'\n", 2_000_000);
  copy("older", "config interface 'first'\n", 1_000_000);
  writeFileSync(`${d.root}/etc/init.d/onc-rollback`, bootScript);
  const boot = spawnSync("sh", ["-c", `. "${d.root}/etc/init.d/onc-rollback"; boot`], { env: { ...process.env, ONC_ROOT: d.root }, encoding: "utf8" });
  t.is(boot.status, 0);
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'first'\n");
  t.false(existsSync(`${d.root}/etc/onc/rollback`), "every copy dropped");
});

// The steps an apply changes the device with: each verb reads its records
// on stdin, says each step as it starts it, and ONC_OK once all are done.

const lines = (log: string) => log.trim().split("\n").map((line) => line.trimEnd());

test("records read back as they were sent: bodies byte for byte, paths whole", (t) => {
  const records: AgentRecord[] = [
    { kind: "seed", path: "/etc/config/a b", content: "config x 'y'\n" },
    { kind: "remove", name: "odhcpd" },
    { kind: "add", name: "nlbwmon" },
    { kind: "batch", operations: ["set a.b=c", "set a.b.d='end'", "delete a.@x[0]"] },
    { kind: "set", key: "a.b.banner", value: "end\n  two\\\n" },
    { kind: "remove-file", path: "/etc/init.d/old one" },
    { kind: "write", path: "/etc/it's here", mode: "0600", content: "end\nno newline", runAfter: "echo 'a'\necho b" },
    { kind: "write", path: "/etc/plain", mode: "0644", content: "" },
    { kind: "commit", config: "network" },
    { kind: "protocol", name: "wireguard" },
    { kind: "enable", name: "dnsmasq" },
    { kind: "disable", name: "mwan3" },
    { kind: "run", command: "printf x" },
  ];
  const back = decodeRecords(encodeRecords(records));
  // A file always ends in a line break (as it was always written); everything else is exact.
  t.deepEqual(back, records.map((r) => (r.kind === "write" ? { ...r, content: r.content.endsWith("\n") ? r.content : `${r.content}\n` } : r)));
  t.throws(() => encodeRecords([{ kind: "remove-file", path: "/etc/a\nb" }]), { message: /one line/ });
  t.throws(() => encodeRecords([{ kind: "commit", config: "a b" }]), { message: /one word/ });
  t.throws(() => decodeRecords("commit network\n"), { message: /cut short/ });
});

test("prepare: reverts first, seeds only what is missing (owner-only), removes, then installs, then the reload baseline", async (t) => {
  const d = device();
  await d.run("begin");
  writeFileSync(`${d.state}/uci-changes`, "network.lan.proto='dhcp'\n");
  writeFileSync(`${d.root}/etc/config/new.apk-new`, "stock\n");
  const out = await d.steps("prepare", [
    { kind: "seed", path: "/etc/config/network", content: "config interface 'ours'\n" },
    { kind: "seed", path: "/etc/config/new", content: "config new 'x'\n\toption key 'secret'\n" },
    { kind: "remove", name: "odhcpd" },
    { kind: "add", name: "nlbwmon" },
    { kind: "add", name: "mwan3" },
  ]);
  t.regex(out.stdout, /^ONC_OK$/m, out.stderr);
  t.is(readFileSync(`${d.root}/etc/config/network`, "utf8"), "config interface 'lan'\n", "an existing config is left");
  t.is(readFileSync(`${d.root}/etc/config/new`, "utf8"), "config new 'x'\n\toption key 'secret'\n");
  t.is(lstatSync(`${d.root}/etc/config/new`).mode & 0o777, 0o600);
  t.false(existsSync(`${d.root}/etc/config/new.apk-new`), "the stock config apk set aside goes");
  const log = lines(d.log());
  const at = (pattern: RegExp) => log.findIndex((line) => pattern.test(line));
  t.true(at(/^uci revert network$/) > -1);
  t.true(at(/^uci revert network$/) < at(/^apk del --rdepends odhcpd$/));
  t.true(at(/^apk del --rdepends odhcpd$/) < at(/^apk add --update-cache nlbwmon mwan3$/));
  t.true(at(/^apk add/) < at(/^reload_config$/));
  t.notRegex(out.stdout, /secret/, "steps name paths and packages, never values");
});

test("stage: one batch, a value spanning lines on its own, stale files gone, files written only when changed", async (t) => {
  const d = device();
  await d.run("begin");
  const path = "/etc/it's a file";
  const records = (content: string): AgentRecord[] => [
    { kind: "batch", operations: ["set system.s=system", "set system.s.hostname='r1'"] },
    { kind: "set", key: "system.s.banner", value: "line one\nline two" },
    { kind: "batch", operations: ["set system.s.zz='z'"] },
    { kind: "remove-file", path: "/etc/init.d/svc" },
    { kind: "write", path, mode: "0600", content, runAfter: `echo ran >> "${d.state}/after"` },
  ];
  const first = await d.steps("stage", records("a $(x) 'q'\n"));
  t.regex(first.stdout, /^ONC_OK$/m, first.stderr);
  t.is(readFileSync(`${d.state}/batch`, "utf8"), "set system.s=system\nset system.s.hostname='r1'\nset system.s.zz='z'\n");
  const log = d.log();
  t.regex(log, /^uci set system\.s\.banner=line one\nline two$/m, "the spanning value whole, between the batches");
  t.true(log.indexOf("uci batch") < log.indexOf("uci set system.s.banner") && log.indexOf("uci set system.s.banner") < log.lastIndexOf("uci batch"));
  t.regex(log, /^svc stop$/m, "a dropped init script is stopped first");
  t.false(existsSync(`${d.root}/etc/init.d/svc`));
  t.is(readFileSync(`${d.root}${path}`, "utf8"), "a $(x) 'q'\n");
  t.is(lstatSync(`${d.root}${path}`).mode & 0o777, 0o600);
  await d.steps("stage", records("a $(x) 'q'\n"));
  t.is(readFileSync(`${d.state}/after`, "utf8"), "ran\n", "the same content: its run_after not run again");
  await d.steps("stage", records("b\n"));
  t.is(readFileSync(`${d.state}/after`, "utf8"), "ran\nran\n");
  t.false(existsSync(`${d.root}${path}.onc-new`));
});

test("stage: a run_after that leaves a process running never holds the call open", async (t) => {
  // Over SSH a call ends only once its streams close: a daemon a run_after
  // starts must not keep them (seen in the rig: a stage that never answered).
  // execFile, like dropbear, waits for the streams too.
  const d = device();
  await d.run("begin");
  const started = Date.now();
  const out = await d.steps("stage", [
    { kind: "write", path: "/etc/daemon.conf", mode: "0644", content: "x\n", runAfter: "(/bin/sleep 8; echo late >&2) &\necho started" },
  ]);
  t.regex(out.stdout, /^ONC_OK$/m, out.stderr);
  t.regex(out.stderr, /started/, "its output still passed on");
  t.true(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test("stage: a batch uci complains about fails the step, by name, with uci's words", async (t) => {
  const d = device();
  await d.run("begin");
  const out = await d.steps("stage", [
    { kind: "batch", operations: ["set wireless.w.key='secret FAIL'"] },
    { kind: "write", path: "/etc/never", mode: "0644", content: "x" },
  ]);
  t.notRegex(out.stdout, /ONC_OK/);
  t.regex(out.stdout, /ONC_STEP uci batch\s*$/);
  t.regex(out.stderr, /Parse error/);
  t.false(existsSync(`${d.root}/etc/never`), "nothing after it is done");
});

test("finalise: each config there committed by name, then the reload; netifd restarted for a protocol it does not know", async (t) => {
  const d = device();
  await d.run("begin");
  stub(`${d.root}/etc/init.d`, "network", `echo "network $*" >> "${d.base}/log"`);
  const out = await d.steps("finalise", [
    { kind: "commit", config: "network" },
    { kind: "commit", config: "gone" },
    { kind: "protocol", name: "wireguard" },
  ]);
  t.regex(out.stdout, /^ONC_OK$/m, out.stderr);
  const log = lines(d.log());
  t.deepEqual(
    log.filter((line) => /^(uci commit|reload_config|network )/.test(line)),
    ["uci commit network", "reload_config", "network restart"]
  );
});

test("services: enabled and started, or stopped and disabled; a missing one skipped, a failure said, not fatal", async (t) => {
  const d = device();
  await d.run("begin");
  for (const name of ["svc", "other"]) {
    stub(
      `${d.root}/etc/init.d`,
      name,
      `echo "${name} $*" >> "${d.base}/log"\ncase "$1" in\n enabled) [ -f "${d.state}/enabled-${name}" ] ;;\n enable) : > "${d.state}/enabled-${name}" ;;\n disable) rm -f "${d.state}/enabled-${name}" ;;\n running) [ -f "${d.state}/running/${name}" ] ;;\n start) exit 1 ;;\n stop) rm -f "${d.state}/running/${name}" ;;\nesac`
    );
  }
  writeFileSync(`${d.state}/enabled-other`, "");
  writeFileSync(`${d.state}/running/other`, "");
  const out = await d.steps("services", [
    { kind: "enable", name: "svc" },
    { kind: "enable", name: "missing" },
    { kind: "disable", name: "other" },
  ]);
  t.regex(out.stdout, /^ONC_OK$/m);
  t.regex(out.stderr, /could not start svc/);
  t.true(existsSync(`${d.state}/enabled-svc`));
  t.false(existsSync(`${d.state}/enabled-other`));
  t.false(existsSync(`${d.state}/running/other`));
});

test("a service with no reload trigger for its config is restarted after a finalise that changed it, and only then", async (t) => {
  const d = device();
  await d.run("begin");
  // md5sum as reload_config uses it, made deterministic: "h<bytes>".
  stub(join(d.base, "bin"), "md5sum", `printf 'h%s  -\\n' "$(cat | wc -c | tr -d ' ')"`);
  writeFileSync(`${d.root}/etc/config/dhcp`, "");
  // The last reload's md5s: network as it is now (uci show says nothing here), dhcp otherwise.
  mkdirSync(`${d.root}/var/run`, { recursive: true });
  writeFileSync(`${d.root}/var/run/config.md5`, "h0  /var/run/config.check/network\nhzz  /var/run/config.check/dhcp\n");
  t.regex((await d.steps("finalise", [{ kind: "commit", config: "network" }, { kind: "commit", config: "dhcp" }])).stdout, /^ONC_OK$/m);
  const out = await d.steps("services", [
    { kind: "restart", name: "svc", config: "dhcp" },
    { kind: "restart", name: "other", config: "network" },
  ]);
  t.regex(out.stdout, /^ONC_OK$/m, out.stderr);
  const log = lines(d.log());
  t.true(log.includes("svc restart"), "its config changed: restarted");
  t.false(log.includes("other restart"), "its config unchanged: left alone");
});

test("services: a restart with no config is unconditional (a package swap the plan knew of)", async (t) => {
  const d = device();
  await d.run("begin");
  stub(`${d.root}/etc/init.d`, "wpad", `echo "wpad $*" >> "${d.base}/log"`);
  const out = await d.steps("services", [{ kind: "restart", name: "wpad" }]);
  t.regex(out.stdout, /^ONC_OK$/m, out.stderr);
  t.true(lines(d.log()).includes("wpad restart"));
});

test("services records: a service restarted on a package swap, when the run changes a matching package", (t) => {
  const { servicesRecords } = require("../../getDeviceScript") as typeof import("../../getDeviceScript");
  const state = stateOf({ services: [{ name: "wpad", running: false, restartOnPackages: ["wpad*"] }, { name: "usteer", running: true }] });
  t.deepEqual(servicesRecords(state, {}, ["usteer"]).filter((r) => r.kind === "restart"), [], "no wpad package changed");
  const records = servicesRecords(state, {}, ["wpad-basic-mbedtls", "wpad-mbedtls"]);
  t.deepEqual(records.filter((r) => r.kind === "restart"), [{ kind: "restart", name: "wpad" }]);
  t.deepEqual(decodeRecords(encodeRecords(records)), records, "round-trips without a config");
});

test("hooks: in order, the one that fails named by its number, nothing after it run", async (t) => {
  const d = device();
  await d.run("begin");
  const out = await d.steps("hooks", [
    { kind: "run", command: `echo one >> "${d.state}/hooks"` },
    { kind: "run", command: "echo broke >&2; exit 3" },
    { kind: "run", command: `echo three >> "${d.state}/hooks"` },
  ]);
  t.notRegex(out.stdout, /ONC_OK/);
  t.regex(out.stdout, /ONC_STEP hook 2\s*$/);
  t.regex(out.stderr, /broke/);
  t.is(readFileSync(`${d.state}/hooks`, "utf8"), "one\n");
});

test("input cut short is refused before anything is done; the step directory is owner-only and goes with done", async (t) => {
  const d = device();
  await d.run("begin");
  writeFileSync(`${d.state}/uci-changes`, "network.lan.proto='dhcp'\n");
  const cut = await d.call("seed 1 /etc/config/x\nconfig x\n", ["prepare"]);
  t.regex(cut.stderr, /cut short/);
  t.notRegex(d.log(), /uci revert/, "not even the revert");
  t.is(lstatSync(join(d.tmp, "onc-steps-t1")).mode & 0o777, 0o700);
  t.deepEqual(readdirSync(join(d.tmp, "onc-steps-t1")), [], "what it read is gone");
  t.true((await d.run("done")).includes("ONC_DONE"));
  t.deepEqual(onc(d.tmp), []);
});

test("revert: every staged change, whoever made it, for configs that are there", async (t) => {
  const d = device();
  await d.run("begin");
  writeFileSync(`${d.state}/uci-changes`, "network.lan.proto='dhcp'\n-gone.x\n");
  t.regex(await d.run("revert"), /^ONC_OK$/m);
  t.regex(d.log(), /^uci revert network$/m);
  t.notRegex(d.log(), /uci revert gone/);
});

test("services records: a running service with no trigger for its own config is restarted if it changed; one procd does not know is not", (t) => {
  const { servicesRecords } = require("../../getDeviceScript") as typeof import("../../getDeviceScript");
  const state = stateOf({ services: [{ name: "dnsmasq", running: true }, { name: "quiet", running: true }, { name: "fresh", running: true }] });
  const records = servicesRecords(state, { dnsmasq: ["dhcp", "system"], quiet: [] });
  t.deepEqual(records.filter((r) => r.kind === "restart"), [{ kind: "restart", name: "quiet", config: "quiet" }]);
  t.deepEqual(decodeRecords(encodeRecords(records)), records, "the restart record round-trips");
});
