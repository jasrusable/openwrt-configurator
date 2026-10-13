// The Status pages answer from what the collector kept, at once, and say
// someone is looking. No test here reads a device: the sample's addresses
// may be a real network's.
import test from "ava";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";
import { readHistory, runCollector, snapshotFreshMs } from "../../status/collector";
import { historyApi, statusApi } from "../../server/handlers";
import { tempDir } from "../helpers/tempDir";
import { writeFileSync } from "fs";

const get = (path: string) => ({ method: "GET", path, body: "", headers: {} });

test("status is answered from a fresh snapshot without reading any device, and marks that someone is looking", async (t) => {
  const dir = tempDir("collector");
  const now = 1_000_000_000;
  const status = { connections: [], devices: [], networks: [], ssids: [], clients: { total: 0, wifi: 0 }, readAt: now - 5000 };
  writeFileSync(join(dir, "status.json"), JSON.stringify({ at: now - 5000, status }));
  // No intent at this path: a read of the devices would fail, not answer.
  const handle = statusApi({ intentPath: join(dir, "missing.json"), platform: nodePlatform, statusDir: dir, now: () => now });
  const response = await handle(get("/api/status"));
  t.is(response.status, 200);
  t.deepEqual(JSON.parse(response.body), status);
  t.is(Number(nodePlatform.readTextFile(join(dir, "wanted"))), now);
  // Too old: no collector is running, so the request reads for itself (here, and fails).
  const stale = statusApi({ intentPath: join(dir, "missing.json"), platform: nodePlatform, statusDir: dir, now: () => now + snapshotFreshMs });
  await t.throwsAsync(() => stale(get("/api/status")));
});

test("history is answered whole, or from a time on", async (t) => {
  const dir = tempDir("collector");
  writeFileSync(join(dir, "history.json"), JSON.stringify({ down: [[60_000, 1, 1], [120_000, 2, 1]] }));
  const handle = historyApi({ platform: nodePlatform, statusDir: dir });
  t.deepEqual(JSON.parse((await handle(get("/api/history"))).body).down.length, 2);
  t.deepEqual(JSON.parse((await handle(get("/api/history/130000"))).body), { down: [[120_000, 2, 1]] });
  t.is((await handle(get("/api/history/soon"))).status, 404);
});

test("the collector reads fast only while someone looks, and says a lasting failure once", async (t) => {
  const dir = tempDir("collector");
  let clock = 0;
  const reads: number[] = [];
  const errors: string[] = [];
  const error = console.error;
  console.error = (message: string) => errors.push(message);
  t.teardown(() => (console.error = error));
  // No intent: every read fails at once, which is all this needs to count reads.
  const platform = { ...nodePlatform, readTextFile: (path: string) => (path.endsWith("missing.json") && reads.push(clock), nodePlatform.readTextFile(path)), sleep: async (ms: number) => void (clock += ms) };
  await runCollector({ intentPath: join(dir, "missing.json"), platform, dir, now: () => clock, stop: () => clock >= 300_000 });
  t.deepEqual(reads, [0, 60_000, 120_000, 180_000, 240_000], "nobody looking: once a minute");
  t.is(errors.length, 1);
  writeFileSync(join(dir, "wanted"), "0");
  reads.length = 0;
  clock = 0;
  await runCollector({ intentPath: join(dir, "missing.json"), platform, dir, now: () => clock, stop: () => clock >= 60_000 });
  t.deepEqual(reads, [0, 10_000, 20_000, 30_000, 40_000, 50_000], "someone looking: every ten seconds");
  t.deepEqual(readHistory(platform, dir), {});
});
