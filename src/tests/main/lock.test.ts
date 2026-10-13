import test from "ava";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { withLock } from "../../lock";
import { nodePlatform } from "../../platforms/node";
import { tempDir } from "../helpers/tempDir";

const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("one holder at a time: the others are told it is busy, and it is given back", async (t) => {
  const lock = join(tempDir("lock"), "a.lock");
  const results = await Promise.all(
    [1, 2, 3, 4].map(() => withLock(nodePlatform, lock, 1, async () => (await later(100), "ran")))
  );
  t.is(results.filter((r) => r === "ran").length, 1, JSON.stringify(results));
  t.false(existsSync(lock));
  t.is(await withLock(nodePlatform, lock, 1, async () => "again"), "again");
});

test("a lock left by a process that died is taken over once stale, by one request only", async (t) => {
  const lock = join(tempDir("lock"), "a.lock");
  mkdirSync(lock);
  t.is(await withLock(nodePlatform, lock, 1, async () => "ran"), "busy", "not yet stale");
  const old = new Date(Date.now() - 5 * 60_000);
  utimesSync(lock, old, old);
  const results = await Promise.all([1, 2, 3, 4].map(() => withLock(nodePlatform, lock, 1, async () => (await later(100), "ran"))));
  t.is(results.filter((r) => r === "ran").length, 1, JSON.stringify(results));
});

test("a holder that outlived a takeover does not free the lock of the one that took it", async (t) => {
  const lock = join(tempDir("lock"), "a.lock");
  const first = withLock(nodePlatform, lock, 1, async () => {
    // Taken over meanwhile: another owner now.
    writeFileSync(join(lock, "owner"), "someone-else\n");
    return "first";
  });
  t.is(await first, "first");
  t.true(existsSync(lock), "left to its new owner");
});
