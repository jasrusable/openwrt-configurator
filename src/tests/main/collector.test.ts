// The Status pages answer from what the collector kept, at once, and say
// someone is looking. No test here reads a device: the sample's addresses
// may be a real network's.
import test from "ava";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";
import { jobPaths, jobRecordKey } from "../../server/provisionJob";
import { write } from "../../store";
import { copyKept, digest, eventsKey, markWanted, readEvents, readHistory, registryKey, runCollector, snapshotFreshMs, State } from "../../status/collector";
import type { NetworkStatus } from "../../status/network";
import { uiHandler } from "../../server/app";
import { tempDir } from "../helpers/tempDir";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { ok } from "../../result";

const get = (path: string) => ({ method: "GET", path, body: "", headers: { "x-onc": "1" } });
const api = (dir: string, now = Date.now) =>
  uiHandler({ intentPath: join(dir, "missing.json"), uiRoot: dir, platform: nodePlatform, statusDir: dir, now });

test("status is answered from a fresh snapshot without reading any device, and marks that someone is looking", async (t) => {
  const dir = tempDir("collector");
  const now = 1_000_000_000;
  const status = { connections: [], devices: [], networks: [], ssids: [], clients: { total: 0, wifi: 0 }, readAt: now - 5000 };
  writeFileSync(join(dir, "status.json"), JSON.stringify({ at: now - 5000, status }));
  // No intent at this path: a read of the devices would fail, not answer.
  const response = await api(dir, () => now)(get("/api/status"));
  t.is(response.status, 200);
  t.deepEqual(JSON.parse(response.body), status);
  t.is(JSON.parse(nodePlatform.readTextFile(join(dir, "wanted"))).value, now);
  // Too old: no collector is running, so the request reads for itself (here, with no settings to read by).
  const stale = await api(dir, () => now + snapshotFreshMs)(get("/api/status"));
  t.is(stale.status, 404);
  t.regex(JSON.parse(stale.body).error, /No settings are saved/);
});

test("history is answered whole, or from a time on", async (t) => {
  const dir = tempDir("collector");
  writeFileSync(join(dir, "history.json"), JSON.stringify({ down: [[60_000, 1, 1], [120_000, 2, 1]] }));
  const handle = api(dir);
  t.deepEqual(JSON.parse((await handle(get("/api/history"))).body).down.length, 2);
  t.deepEqual(JSON.parse((await handle(get("/api/history/130000"))).body), { down: [[120_000, 2, 1]] });
  t.is((await handle(get("/api/history/soon"))).status, 404);
  // 30 days at 15 minutes, beside the day.
  const quarter = 15 * 60_000;
  writeFileSync(join(dir, "history-month.json"), JSON.stringify({ format: 1, value: { down: [[quarter, 1, 4], [2 * quarter, 2, 3]] } }));
  t.deepEqual(JSON.parse((await handle(get("/api/history/month"))).body).down.length, 2);
  t.deepEqual(JSON.parse((await handle(get("/api/history/month/" + (2 * quarter + 60_000)))).body), { down: [[2 * quarter, 2, 3]] }, "the quarter hour still filling comes again");
  t.is((await handle(get("/api/history/month/soon"))).status, 404);
});

test.serial("the collector reads fast only while someone looks, and says a lasting failure once", async (t) => {
  const dir = tempDir("collector");
  let clock = 0;
  const reads: number[] = [];
  const errors: string[] = [];
  const error = console.error;
  console.error = (message: string) => errors.push(message);
  t.teardown(() => (console.error = error));
  // No intent: every read fails at once, which is all this needs to count reads.
  // Each read starts by looking for the settings file: counted there.
  const platform = { ...nodePlatform, fileMode: (path: string) => (path.endsWith("missing.json") && reads.push(clock), nodePlatform.fileMode(path)), sleep: async (ms: number) => void (clock += ms) };
  await runCollector({ intentPath: join(dir, "missing.json"), platform, dir, now: () => clock, stop: () => clock >= 300_000 });
  t.deepEqual(reads, [0, 60_000, 120_000, 180_000, 240_000], "nobody looking: once a minute");
  t.is(errors.length, 1);
  markWanted(platform, dir, 0);
  reads.length = 0;
  clock = 0;
  await runCollector({ intentPath: join(dir, "missing.json"), platform, dir, now: () => clock, stop: () => clock >= 60_000 });
  t.deepEqual(reads, [0, 10_000, 20_000, 30_000, 40_000, 50_000], "someone looking: every ten seconds");
  t.deepEqual(readHistory(platform, dir), {});
});

test("while an apply runs, status is what was read before, marked so, and no device is read", async (t) => {
  const dir = tempDir("collector");
  const intentPath = join(dir, "missing.json");
  // A job starting: its lock taken, its record written, no pid yet (src/server/provisionJob.ts).
  mkdirSync(jobPaths(intentPath).lock, { recursive: true });
  write(nodePlatform, jobRecordKey(jobPaths(intentPath).dir), { runId: "r", startedAt: Date.now() });
  const handle = api(dir);
  const none = await handle(get("/api/status"));
  t.is(none.status, 409, "nothing kept, and nothing read: the apply is why");
  t.regex(JSON.parse(none.body).error, /being applied/);
  const status = { connections: [], devices: [], networks: [], ssids: [], clients: { total: 0, wifi: 0 }, readAt: 1 };
  writeFileSync(join(dir, "status.json"), JSON.stringify({ at: 1, status }));
  const kept = await handle(get("/api/status"));
  t.is(kept.status, 200, "however old");
  t.deepEqual(JSON.parse(kept.body), { ...status, applying: true });
});

test.serial("the collector goes on after a read that throws, and says it once", async (t) => {
  const dir = tempDir("collector");
  let clock = 0;
  let calls = 0;
  const errors: string[] = [];
  const error = console.error;
  console.error = (message: string) => errors.push(message);
  t.teardown(() => (console.error = error));
  const platform = { ...nodePlatform, sleep: async (ms: number) => void (clock += ms) };
  await runCollector({
    intentPath: join(dir, "missing.json"),
    platform,
    dir,
    now: () => clock,
    stop: () => clock >= 180_000,
    collect: async ({ state }) => {
      calls++;
      if (calls < 3) throw new Error("No space left on device");
      return ok(state);
    },
  });
  t.is(calls, 3, "read again each minute");
  t.deepEqual(errors, ["Reading status: No space left on device"]);
});

test("a mark of someone looking kept before the store still counts", async (t) => {
  const dir = tempDir("collector");
  let clock = 0;
  let calls = 0;
  writeFileSync(join(dir, "wanted"), "0");
  const platform = { ...nodePlatform, sleep: async (ms: number) => void (clock += ms) };
  await runCollector({
    intentPath: join(dir, "missing.json"),
    platform,
    dir,
    now: () => clock,
    stop: () => clock >= 30_000,
    collect: async ({ state }) => (calls++, ok(state)),
  });
  t.is(calls, 3, "every ten seconds");
});

const network = (over: Partial<NetworkStatus> = {}): NetworkStatus => ({
  internet: { up: true, ipv4: [], ipv6: [] },
  connections: [{ id: "wan", name: "Fibre", up: true, ipv4: [], ipv6: [], uptime: 100, inUse: true }],
  devices: [{ name: "loft", role: "access-point" }],
  networks: [],
  ssids: [],
  clients: { total: 0, wifi: 0 },
  unexpected: { interfaces: [], ssids: [] },
  deviceViews: [{ name: "loft", role: "access-point", reachable: true, uptime: 100, ports: [] }],
  radios: [{ accessPoint: "loft", ifname: "phy1-ap0", band: "5 GHz", clients: 1, airtime: { active: 1_000_000, busy: 100_000 } }],
  clientList: [],
  reservations: [],
  ...over,
});

const phone = { mac: "a4:83:e7:00:00:01", name: "Phone", ipv6: [], network: "lan", connection: { kind: "wifi" as const, accessPoint: "loft", signal: -60, txRate: 400 }, state: "online" as const, reserved: false, heardBy: [] };

test("a read digested: busy from two reads, clients remembered and the new one told, what changed told, numbers in the history", (t) => {
  const empty: State = { histories: { day: {}, month: {} }, counts: {} };
  const t0 = 10_000_000;
  const first = digest({ read: network(), at: t0, state: empty });
  t.deepEqual(first.snapshot.status.events, []);
  t.is(first.snapshot.status.radios?.[0].busy, undefined, "one read: not yet");
  const second = digest({
    read: network({
      connections: [{ id: "wan", name: "Fibre", up: false, ipv4: [], ipv6: [], inUse: false }],
      // Its clock moved on with the reads: no restart.
      deviceViews: [{ name: "loft", role: "access-point", reachable: true, uptime: 100 + 15 * 60, ports: [] }],
      radios: [{ accessPoint: "loft", ifname: "phy1-ap0", band: "5 GHz", clients: 1, airtime: { active: 1_010_000, busy: 104_000 } }],
      clientList: [phone],
    }),
    at: t0 + 15 * 60_000,
    state: first.state,
    networkName: (id) => (id === "lan" ? "Home" : undefined),
  });
  const status = second.snapshot.status;
  t.is(status.radios?.[0].busy, 40);
  t.deepEqual(status.events?.map((e) => e.text), ["Fibre went down", "New device: Phone on Home"], "both seen by this read");
  t.like(status.clientList?.[0], { mac: phone.mac, new: true, firstSeen: t0 + 15 * 60_000 });
  t.deepEqual(second.state.histories.day["line:wan"]?.map((p) => p[1]), [1, 0]);
  t.deepEqual(second.state.histories.day["busy:loft:5 GHz"]?.map((p) => p[1]), [40]);
  t.deepEqual(Object.keys(second.state.clientHistory ?? {}).sort(), ["rate:a4:83:e7:00:00:01", "signal:a4:83:e7:00:00:01"]);
  // An apply that ended is told once, by when it started.
  const applied = { at: t0, kind: "apply" as const, severity: "ok" as const, subject: "app:apply", text: "Settings applied" };
  const third = digest({
    read: network({ clientList: [phone], deviceViews: [{ name: "loft", role: "access-point", reachable: true, uptime: 100 + 16 * 60, ports: [] }] }),
    at: t0 + 16 * 60_000,
    state: second.state,
    applied,
  });
  t.is(third.state.applyTold, t0);
  t.true(third.snapshot.status.events?.some((e) => e.text === "Settings applied"));
});

test("what is worth keeping is copied from RAM to flash, and back at the next start only where RAM has none", (t) => {
  const ram = tempDir("collector-ram");
  const flash = tempDir("collector-flash");
  const events = [{ at: 1, kind: "line" as const, severity: "problem" as const, subject: "line:wan", text: "Fibre went down" }];
  write(nodePlatform, eventsKey(ram), events);
  writeFileSync(join(ram, "status.json"), JSON.stringify({ at: 1, status: {} }));
  copyKept(nodePlatform, ram, flash);
  t.deepEqual(readEvents(nodePlatform, flash), events);
  t.false(existsSync(join(flash, "status.json")), "the snapshot is read again in seconds: never on flash");
  // After a reboot RAM is empty: taken from flash. A newer RAM copy is left as it is.
  const rebooted = tempDir("collector-ram");
  copyKept(nodePlatform, flash, rebooted, true);
  t.deepEqual(readEvents(nodePlatform, rebooted), events);
  write(nodePlatform, eventsKey(rebooted), []);
  copyKept(nodePlatform, flash, rebooted, true);
  t.deepEqual(readEvents(nodePlatform, rebooted), []);
});

test("events are answered whole or from a time on; one client as remembered, with its own series", async (t) => {
  const dir = tempDir("collector");
  const e = (at: number) => ({ at, kind: "line" as const, severity: "info" as const, subject: "line:wan", text: `at ${at}` });
  write(nodePlatform, eventsKey(dir), [e(3000), e(2000), e(1000)]);
  write(nodePlatform, registryKey(dir), { since: 0, clients: { [phone.mac]: { mac: phone.mac, firstSeen: 5, lastSeen: 9, name: "Phone" } } });
  writeFileSync(join(dir, "client-history.json"), JSON.stringify({ format: 1, value: { [`signal:${phone.mac}`]: [[0, -60, 1]], "signal:other": [[0, -80, 1]] } }));
  const handle = api(dir);
  t.is(JSON.parse((await handle(get("/api/events"))).body).length, 3);
  t.deepEqual(JSON.parse((await handle(get("/api/events/1500"))).body).map((x: { at: number }) => x.at), [3000, 2000]);
  const one = JSON.parse((await handle(get(`/api/clients/${encodeURIComponent(phone.mac.toUpperCase())}`))).body);
  t.deepEqual(one, { known: { mac: phone.mac, firstSeen: 5, lastSeen: 9, name: "Phone" }, history: { signal: [[0, -60, 1]] } });
  t.is((await handle(get("/api/clients/../../etc"))).status, 404);
});
