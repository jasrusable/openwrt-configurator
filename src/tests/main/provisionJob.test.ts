// The UI's apply job: started detached, alive while its process has its run
// id, ended by the run itself saying how. Processes are faked (a pid and a
// command line, or none); files are real.
import test from "ava";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { main } from "../../cli";
import { nodePlatform } from "../../platforms/node";
import { jobEnding, jobPaths, jobRecordKey, provisionStatus, startProvision } from "../../server/provisionJob";
import { write } from "../../store";
import { tempDir } from "../helpers/tempDir";
import { sampleIntentText } from "../helpers/fixtures";
import { uiHandler } from "../../server/app";

/** A machine of fake processes: each pid's command line, and what was started. */
const machine = () => {
  const processes = new Map<number, string>();
  const started: string[][] = [];
  let nextPid = 1000;
  let clock = 1_000_000;
  const platform = {
    ...nodePlatform,
    selfCommand: () => ["onc"],
    spawnDetached: (argv: string[], { log }: { log: string }) => {
      const pid = nextPid++;
      processes.set(pid, argv.join(" "));
      started.push(argv);
      writeFileSync(log, `ran ${argv.slice(1, 3).join(" ")}\n`);
      return pid;
    },
    commandLineOf: async (pid: number) => processes.get(pid),
  };
  /** The run started last, as it would see itself: its pid, and how it ends. */
  const run = () => {
    const argv = started[started.length - 1];
    const dir = argv[argv.indexOf("--job") + 1];
    const runId = argv[argv.indexOf("--run-id") + 1];
    const pid = [...processes].find(([, line]) => line === argv.join(" "))?.[0];
    const end = jobEnding(platform, dir, runId, () => clock);
    return {
      runId,
      /** Ends as provision does: says how, then exits. */
      exits: (exitCode: number) => (end({ exitCode }), pid !== undefined && processes.delete(pid)),
      /** SIGTERM: its handler says so, then it exits. */
      stopped: () => (end({ signal: "SIGTERM" }), pid !== undefined && processes.delete(pid)),
      /** kill -9, out of memory: gone without a word. */
      killed: () => pid !== undefined && processes.delete(pid),
      pid: pid!,
    };
  };
  return { platform, processes, run, now: () => clock, advance: (ms: number) => void (clock += ms) };
};

const withIntent = () => {
  const intentPath = join(tempDir("job"), "intent.json");
  writeFileSync(intentPath, JSON.stringify({ schema: 1, system: { name: "A" } }));
  return intentPath;
};

const status = (intentPath: string, m: ReturnType<typeof machine>) => provisionStatus({ intentPath, files: m.platform, now: m.now });
const start = (intentPath: string, m: ReturnType<typeof machine>) => startProvision({ intentPath, files: m.platform, now: m.now });

test("a run that applied makes the snapshot it took live, and says it succeeded", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  t.is((await status(intentPath, m)).state, "idle");
  t.true((await start(intentPath, m)).started);
  const running = await status(intentPath, m);
  t.is(running.state, "running");
  t.is(running.startedAt, m.now());
  t.regex(running.log, /ran provision .*provisioning\.json/);
  // An edit during the run is not what gets provisioned.
  writeFileSync(intentPath, JSON.stringify({ schema: 1, system: { name: "B" } }));
  m.run().exits(0);
  const done = await status(intentPath, m);
  t.is(done.state, "succeeded");
  t.is(done.exitCode, 0);
  t.is(JSON.parse(readFileSync(jobPaths(intentPath).live, "utf8")).system.name, "A");
  t.is(done.live, "differs", "the draft moved on during the run");
  t.false(existsSync(jobPaths(intentPath).lock), "the lock is given back");
});

test("a run applied everywhere whose later step failed is live, and says so", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  m.run().exits(3);
  const done = await status(intentPath, m);
  t.is(done.state, "applied-with-problems");
  t.is(done.live, "matches");
});

test("a failed run leaves what was live", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  m.run().exits(4);
  const done = await status(intentPath, m);
  t.is(done.state, "failed");
  t.is(done.exitCode, 4);
  t.is(done.live, "none");
});

test("a run asked to stop says so: interrupted, its lock given back", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  m.run().stopped();
  t.is((await status(intentPath, m)).state, "interrupted");
  t.false(existsSync(jobPaths(intentPath).lock));
  t.true((await start(intentPath, m)).started);
});

test("a run killed outright reads as interrupted, and its lock is taken over", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  m.run().killed();
  t.is((await status(intentPath, m)).state, "interrupted");
  t.true(existsSync(jobPaths(intentPath).lock), "left behind");
  t.true((await start(intentPath, m)).started, "a dead run's lock is taken over");
  t.is((await status(intentPath, m)).state, "running");
});

test("a pid handed to another process is not the run: after it died, or a reboot", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  const run = m.run();
  m.processes.set(run.pid, "/usr/sbin/dnsmasq -C /var/etc/dnsmasq.conf");
  t.is((await status(intentPath, m)).state, "interrupted", "same pid, another program");
  m.processes.set(run.pid, `onc provision x --run-id not-${run.runId}`);
  t.is((await status(intentPath, m)).state, "interrupted", "same program, another run");
  m.processes.clear();
  t.is((await status(intentPath, m)).state, "interrupted", "after a reboot: the record kept, no such pid");
  t.true((await start(intentPath, m)).started);
});

test("one run at a time: requests while one runs, or several at once, start one", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  const all = await Promise.all([1, 2, 3].map(() => start(intentPath, m)));
  t.is(all.filter((r) => r.started).length, 1, JSON.stringify(all));
  t.deepEqual(all.filter((r) => !r.started).map((r) => r.reason), ["Settings are already being applied.", "Settings are already being applied."]);
  t.false((await start(intentPath, m)).started, "while it runs");
  m.run().exits(0);
  t.true((await start(intentPath, m)).started, "once it has ended");
});

test("requests at the same moment over a dead run's lock start one run", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  m.run().killed();
  const all = await Promise.all([1, 2, 3, 4].map(() => start(intentPath, m)));
  t.is(all.filter((r) => r.started).length, 1, JSON.stringify(all));
});

test("a run being started (its record, no pid yet) holds for a minute, then is taken over", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  const paths = jobPaths(intentPath);
  // Taken, its record written, and the server killed before it spawned.
  m.platform.makeDir(paths.dir);
  m.platform.makeDir(paths.lock);
  writeFileSync(join(paths.lock, "owner"), "half-started");
  write(m.platform, jobRecordKey(paths.dir), { runId: "half-started", startedAt: m.now() });
  t.is((await status(intentPath, m)).state, "running");
  t.false((await start(intentPath, m)).started);
  m.advance(61_000);
  t.is((await status(intentPath, m)).state, "interrupted");
  t.true((await start(intentPath, m)).started);
});

test("a run that could not be started says so, and leaves the lock free", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  const platform = { ...m.platform, spawnDetached: () => { throw new Error("qjs: command not found"); } };
  const result = await startProvision({ intentPath, files: platform, now: m.now });
  t.false(result.started);
  t.regex(!result.started ? result.reason : "", /command not found/);
  t.is((await status(intentPath, m)).state, "failed");
  t.true((await start(intentPath, m)).started);
});

test("provision --job says how it ended, even when it ends before reaching a device", async (t) => {
  const intentPath = join(tempDir("job-cli"), "intent.json");
  const { dir } = jobPaths(intentPath);
  const quiet = { ...nodePlatform, onStop: () => {} };
  write(nodePlatform, jobRecordKey(dir), { runId: "r1", startedAt: 1 });
  await t.throwsAsync(() => main({ argv: ["provision", join(dir, "missing.json"), "--job", dir, "--run-id", "r1"], platform: quiet }));
  const state = await provisionStatus({ intentPath, files: { ...nodePlatform, commandLineOf: async () => undefined } });
  t.is(state.state, "failed");
  t.is(state.exitCode, 1);
  await t.throwsAsync(() => main({ argv: ["provision", "x.json", "--job", dir], platform: quiet }), { message: /go together/ });
});

test("on this machine: a detached program is found by its run id while it runs, and not after", async (t) => {
  const log = join(tempDir("detached"), "log");
  const pid = nodePlatform.spawnDetached([process.execPath, "-e", "setTimeout(() => {}, 1500)", "--", "--run-id", "abc123"], { log });
  t.true((await nodePlatform.commandLineOf(pid))?.includes("--run-id abc123"));
  await new Promise((r) => setTimeout(r, 2500));
  t.is(await nodePlatform.commandLineOf(pid), undefined);
});

test("an apply keeps the live settings it replaces, when each was applied, and what it changed", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  m.run().exits(0);
  const first = m.now();
  m.advance(60_000);
  writeFileSync(intentPath, JSON.stringify({ schema: 1, system: { name: "B" } }));
  await start(intentPath, m);
  const running = await status(intentPath, m);
  t.false(running.run?.undo);
  t.true((running.run?.changes ?? []).some((c) => c.path === "system.name"), "its changes, kept from its start");
  m.run().exits(0);
  const done = await status(intentPath, m);
  t.is(JSON.parse(readFileSync(jobPaths(intentPath).previous, "utf8")).system.name, "A");
  t.deepEqual(done.applied, { live: m.now(), previous: first });
});

test("a failed apply keeps the previous settings as they were", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  m.run().exits(0);
  writeFileSync(intentPath, JSON.stringify({ schema: 1, system: { name: "B" } }));
  await start(intentPath, m);
  m.run().exits(4);
  t.false(existsSync(jobPaths(intentPath).previous), "nothing was replaced");
  t.is(JSON.parse(readFileSync(jobPaths(intentPath).live, "utf8")).system.name, "A");
});

test("an undo applies the previous settings again, and leaves the saved file alone", async (t) => {
  const m = machine();
  const intentPath = withIntent();
  await start(intentPath, m);
  m.run().exits(0);
  writeFileSync(intentPath, JSON.stringify({ schema: 1, system: { name: "B" } }));
  await start(intentPath, m);
  m.run().exits(0);
  const paths = jobPaths(intentPath);
  t.true((await startProvision({ intentPath, files: m.platform, now: m.now, source: paths.previous, undo: true })).started);
  t.true((await status(intentPath, m)).run?.undo);
  t.is(JSON.parse(readFileSync(paths.snapshot, "utf8")).system.name, "A", "the previous settings are what runs");
  m.run().exits(0);
  t.is(JSON.parse(readFileSync(paths.live, "utf8")).system.name, "A");
  t.is(JSON.parse(readFileSync(paths.previous, "utf8")).system.name, "B", "and the undone one can be put back in turn");
  t.is(JSON.parse(readFileSync(intentPath, "utf8")).system.name, "B", "the saved settings are untouched");
  t.is((await status(intentPath, m)).live, "differs");
});

test("undo through the API: none to undo, refused while running, and restoring the saved settings too", async (t) => {
  const m = machine();
  const dir = tempDir("undo");
  const intentPath = join(dir, "intent.json");
  const sample = sampleIntentText();
  writeFileSync(intentPath, sample, { mode: 0o600 });
  const handle = uiHandler({ intentPath, uiRoot: dir, platform: m.platform, now: m.now });
  const undo = (body: object) => handle({ method: "POST", path: "/api/provision/undo", body: JSON.stringify(body), headers: { "x-onc": "1" } });
  t.is((await undo({})).status, 404, "nothing applied yet");
  await start(intentPath, m);
  m.run().exits(0);
  const renamed = JSON.parse(sample);
  renamed.system.name = "Elsewhere";
  writeFileSync(intentPath, JSON.stringify(renamed), { mode: 0o600 });
  await start(intentPath, m);
  t.is((await undo({})).status, 409, "while a run is going");
  m.run().exits(0);
  const preview = JSON.parse((await handle({ method: "GET", path: "/api/provision", body: "", headers: { "x-onc": "1" } })).body);
  t.true(preview.previous.changes.some((c: { path: string }) => c.path === "system.name"), "the preview: what the undo puts back");
  t.is((await undo({ restoreSettings: true })).status, 202);
  t.is(JSON.parse(readFileSync(intentPath, "utf8")).system.name, "Home", "the saved settings are the previous ones again");
});

test("an upgrade through the API is the apply job with its firmware step first: one at a time, devices by name", async (t) => {
  const m = machine();
  const dir = tempDir("upgrade-job");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, sampleIntentText(), { mode: 0o600 });
  const handle = uiHandler({ intentPath, uiRoot: dir, platform: m.platform, now: m.now });
  const upgrade = (body: object) => handle({ method: "POST", path: "/api/firmware/upgrade", body: JSON.stringify(body), headers: { "x-onc": "1" } });
  t.is((await upgrade({ devices: ["home ap; reboot"] })).status, 400);
  t.is((await upgrade({ devices: ["home-ap-1"] })).status, 202);
  const argv = m.processes.get(m.run().pid)!.split(" ");
  t.deepEqual(argv.slice(argv.indexOf("--upgrade"), argv.indexOf("--upgrade") + 2), ["--upgrade", "home-ap-1"]);
  t.is((await upgrade({})).status, 409, "while a run is going: an upgrade is an apply");
  m.run().exits(0);
  t.is((await upgrade({})).status, 202);
  t.true(m.processes.get(m.run().pid)!.includes("--upgrade all"));
  t.false(m.processes.get(m.run().pid)!.includes("--accept-new-series"), "a new series is acknowledged only when asked");
  m.run().exits(0);
  t.is((await upgrade({ acceptNewSeries: true })).status, 202);
  t.true(m.processes.get(m.run().pid)!.includes("--upgrade all --accept-new-series"));
  m.run().exits(0);
  t.is((await upgrade({ devices: ["home-ap-1"], acceptDowngrade: true })).status, 202);
  t.true(m.processes.get(m.run().pid)!.includes("--upgrade home-ap-1 --accept-downgrade"));
});
