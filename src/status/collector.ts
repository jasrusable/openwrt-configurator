// One loop owns reading the devices for the Status pages: it reads them all
// (read.ts), keeps the result as a snapshot every page answers from at once,
// and adds its numbers to the graphs' history (history.ts). Fast while
// someone has the app open (each status request leaves a mark), slow
// otherwise, so the graphs have no gaps; never while an apply runs. On a
// Mac it runs inside `onc ui`, writing beside the intent; on a router it is
// its own service (`onc collect`), writing to RAM, which the CGI reads.
import { z } from "zod";
import { Platform } from "../platform";
import { fail, Problem, problem } from "../problem";
import { Result, attempt, map, messageOf, ok } from "../result";
import { jobState } from "../server/provisionJob";
import { read, StoreFiles, StoreKey, write } from "../store";
import { bucketMs, Histories, History, LineCounts, Range, readingsOf, throughputOf, withReadingsEverywhere } from "./history";
import { NetworkStatus } from "./network";
import { readNetworkStatus } from "./read";

export type Snapshot = { at: number; status: NetworkStatus };

// Shapes checked lightly: only the collector writes them, and their format
// number is raised when NetworkStatus or the history's points change. Kept
// before the store, they were the values as written: still good.
const asWritten = (stored: unknown, format: number | undefined) => (format === undefined ? stored : undefined);
const snapshotKey = (dir: string): StoreKey<Snapshot> => ({
  path: `${dir}/status.json`,
  schema: z.object({ at: z.number(), status: z.custom<NetworkStatus>((v) => !!v && typeof v === "object") }),
  format: 1,
  upgrade: asWritten,
});
/** Each range's points: the day's where they always were, the month's beside them. */
const historyKey = (dir: string, range: Range = "day"): StoreKey<History> => ({
  path: range === "day" ? `${dir}/history.json` : `${dir}/history-${range}.json`,
  schema: z.custom<History>((v) => !!v && typeof v === "object" && !Array.isArray(v)),
  format: 1,
  upgrade: asWritten,
});
/** When a page last asked for status. */
const wantedKey = (dir: string): StoreKey<number> => ({ path: `${dir}/wanted`, schema: z.number(), format: 1, upgrade: asWritten });

/** How fast to read: while someone looks, and otherwise (for the graphs). */
export const watchedEveryMs = 10_000;
export const unwatchedEveryMs = 60_000;
/** A page asked within this: someone is looking. */
const watchingForMs = 10 * 60_000;
/** A snapshot older than this is not answered from (no collector running): the request reads itself. */
export const snapshotFreshMs = unwatchedEveryMs + 30_000;

/** A page wants status: read fast for a while. */
export const markWanted = (files: StoreFiles, dir: string, now: number) => {
  try {
    write(files, wantedKey(dir), now);
  } catch {
    // Read at the slow pace meanwhile.
  }
};

export const readSnapshot = (files: Pick<Platform, "readTextFile">, dir: string) => read(files, snapshotKey(dir));

export const readHistory = (files: Pick<Platform, "readTextFile">, dir: string, range: Range = "day"): History =>
  read(files, historyKey(dir, range)) ?? {};

const readHistories = (files: Pick<Platform, "readTextFile">, dir: string): Histories => ({
  day: readHistory(files, dir, "day"),
  month: readHistory(files, dir, "month"),
});

/** Whether an apply is running: its devices are mid-change, and nothing reads them meanwhile. */
const applying = async (intentPath: string, platform: Platform) =>
  (await jobState({ intentPath, files: platform }).catch(() => undefined))?.state === "running";

/**
 * What the status pages show now: the snapshot, when it is fresh or an apply
 * is running (then marked so, as old as it is; with none, the apply is the
 * reason); otherwise read now and kept (a request with no collector).
 */
export const currentStatus = async ({
  intentPath,
  platform,
  dir,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  dir: string;
  now?: () => number;
}): Promise<Result<NetworkStatus, Problem>> => {
  const kept = readSnapshot(platform, dir);
  if (await applying(intentPath, platform)) {
    return kept
      ? ok({ ...kept.status, applying: true })
      : fail("conflict", "Settings are being applied: the devices are read again once that has finished.");
  }
  if (kept && now() - kept.at < snapshotFreshMs) return ok(kept.status);
  return map(await readAndKeep({ intentPath, platform, dir, now }), (snapshot) => snapshot.status);
};

/** Read every device now and keep it as the snapshot (a request with no collector to answer it). */
export const readAndKeep = async ({
  intentPath,
  platform,
  dir,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  dir: string;
  now?: () => number;
}): Promise<Result<Snapshot, Problem>> =>
  map(await readNetworkStatus({ intentPath, platform, now }), (status) => {
    const snapshot: Snapshot = { at: now(), status: { ...status, readAt: now() } };
    write(platform, snapshotKey(dir), snapshot);
    return snapshot;
  });

type State = { histories: Histories; counts: LineCounts; savedBucket?: number };

/** One read: the snapshot, with the throughput since the last, and its numbers in the history. */
export const collectOnce = async ({
  intentPath,
  platform,
  dir,
  now = Date.now,
  state,
}: {
  intentPath: string;
  platform: Platform;
  dir: string;
  now?: () => number;
  state: State;
}): Promise<Result<State, Problem>> => {
  const read = await readNetworkStatus({ intentPath, platform, now });
  if (!read.ok) return read;
  const status = read.value;
  const at = now();
  const { counts, ...throughput } = throughputOf(status.internetCounters, state.counts);
  write(platform, snapshotKey(dir), { at, status: { ...status, throughput, readAt: at } });
  const histories = withReadingsEverywhere(state.histories, at, readingsOf(status, throughput), status.devices.map((d) => d.name));
  // Saved as each minute starts: a restart loses a minute at most, and a
  // router's RAM (or a Mac's disk) is written once a minute, not each read.
  const bucket = at - (at % bucketMs);
  if (bucket !== state.savedBucket) {
    write(platform, historyKey(dir, "day"), histories.day);
    write(platform, historyKey(dir, "month"), histories.month);
  }
  return ok({ histories, counts, savedBucket: bucket });
};

/** Read for as long as it runs (or until `stop` says so, for tests). */
export const runCollector = async ({
  intentPath,
  platform,
  dir,
  now = Date.now,
  tickMs = 2_000,
  stop = () => false,
  collect = collectOnce,
  everyHour,
}: {
  intentPath: string;
  platform: Platform;
  dir: string;
  now?: () => number;
  tickMs?: number;
  stop?: () => boolean;
  /** One read (tests give their own). */
  collect?: typeof collectOnce;
  /** Work done once an hour beside the reads: asking OpenWrt for its releases (it asks at most once a day). */
  everyHour?: () => Promise<unknown>;
}) => {
  let state: State = { histories: readHistories(platform, dir), counts: {} };
  let lastRead = -Infinity;
  let lastHourly = -Infinity;
  let lastError: string | undefined;
  while (!stop()) {
    const t = now();
    const wanted = read(platform, wantedKey(dir));
    const watched = wanted !== undefined && t - wanted < watchingForMs;
    const every = watched ? watchedEveryMs : unwatchedEveryMs;
    if (t - lastRead >= every) {
      // An apply's devices are mid-change: leave them to it.
      if (!(await applying(intentPath, platform))) {
        lastRead = t;
        // Whatever goes wrong (a full disk, a bug) is said, and the loop goes on.
        const attempted = await attempt(
          () => collect({ intentPath, platform, dir, now, state }),
          (thrown) => problem("internal", messageOf(thrown))
        );
        const result = attempted.ok ? attempted.value : attempted;
        if (result.ok) state = result.value;
        // Said once, not every read (no intent yet, say).
        const error = result.ok ? undefined : result.error.message;
        if (error !== undefined && error !== lastError) console.error(`Reading status: ${error}`);
        lastError = error;
      }
    }
    if (everyHour && t - lastHourly >= 3_600_000) {
      lastHourly = t;
      // Its own failures are its own: a missed ask is asked next hour.
      await attempt(everyHour, () => undefined);
    }
    await platform.sleep(tickMs);
  }
  return state;
};
