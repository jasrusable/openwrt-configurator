// The Status pages answer from what the collector kept, at once, and say
// someone is looking. No test here reads a device: the sample's addresses
// may be a real network's.
import test from "ava";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";
import { jobPaths, jobRecordKey } from "../../apply/job";
import { write } from "../../store";
import { currentStatus, markWanted, readHistory, runCollector, snapshotFreshMs } from "../../status/collector";
import { uiHandler } from "../../server/app";
import { tempDir } from "../helpers/tempDir";
import { mkdirSync, writeFileSync } from "fs";
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
  // A job starting: its lock taken, its record written, no pid yet (src/apply/job.ts).
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

test("the hourly work runs beside the reads: one that never answers holds none of them up", async (t) => {
  const dir = tempDir("collector");
  let clock = 0;
  let calls = 0;
  let asks = 0;
  // The loop's ticks pass; the hourly work's own time limit never does here.
  const platform = { ...nodePlatform, sleep: (ms: number) => (ms > 60_000 ? new Promise<void>(() => {}) : ((clock += ms), Promise.resolve())) };
  await runCollector({
    intentPath: join(dir, "missing.json"),
    platform,
    dir,
    now: () => clock,
    stop: () => clock >= 180_000,
    collect: async ({ state }) => (calls++, ok(state)),
    everyHour: () => (asks++, new Promise(() => {})),
  });
  t.is(calls, 3, "read each minute all the same");
  t.is(asks, 1);
});

test("requests with no collector share one read of the devices, not one each", async (t) => {
  const dir = tempDir("collector");
  const intentPath = join(dir, "missing.json");
  let reads = 0;
  // Each read starts by looking for the settings file: counted there.
  const platform = { ...nodePlatform, fileMode: (path: string) => (path === intentPath && reads++, nodePlatform.fileMode(path)) };
  const answers = await Promise.all([1, 2, 3].map(() => currentStatus({ intentPath, platform, dir })));
  t.is(reads, 1);
  t.deepEqual(new Set(answers.map((a) => (a.ok ? "read" : a.error.message))).size, 1, "each told the one read's answer");
});
