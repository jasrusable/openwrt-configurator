// One loop owns reading the devices for the Status pages: it reads them all
// (read.ts), keeps the result as a snapshot every page answers from at once,
// and adds its numbers to the graphs' history (history.ts). Fast while
// someone has the app open (each status request leaves a mark), slow
// otherwise, so the graphs have no gaps; never while an apply runs. On a
// Mac it runs inside `onc ui`, writing beside the intent; on a router it is
// its own service (`onc collect`), writing to RAM, which the CGI reads.
import { Platform } from "../platform";
import { parseJson } from "../parseJson";
import { jobState } from "../server/provisionJob";
import { bucketMs, History, LineCounts, readingsOf, throughputOf, withReadings } from "./history";
import { NetworkStatus } from "./network";
import { readNetworkStatus } from "./read";

type Files = Pick<Platform, "readTextFile" | "writeFileAtomic" | "mkdirp">;

export type Snapshot = { at: number; status: NetworkStatus };

const paths = (dir: string) => ({
  snapshot: `${dir}/status.json`,
  history: `${dir}/history.json`,
  wanted: `${dir}/wanted`,
});

/** How fast to read: while someone looks, and otherwise (for the graphs). */
export const watchedEveryMs = 10_000;
export const unwatchedEveryMs = 60_000;
/** A page asked within this: someone is looking. */
const watchingForMs = 10 * 60_000;
/** A snapshot older than this is not answered from (no collector running): the request reads itself. */
export const snapshotFreshMs = unwatchedEveryMs + 30_000;

const readJson = (files: Pick<Platform, "readTextFile">, path: string): unknown => {
  try {
    return parseJson(files.readTextFile(path), path);
  } catch {
    return undefined;
  }
};

const write = (files: Files, dir: string, path: string, value: unknown) => {
  files.mkdirp(dir);
  files.writeFileAtomic(path, JSON.stringify(value), 0o600);
};

/** A page wants status: read fast for a while. */
export const markWanted = (files: Files, dir: string, now: number) => {
  try {
    write(files, dir, paths(dir).wanted, now);
  } catch {
    // Read at the slow pace meanwhile.
  }
};

export const readSnapshot = (files: Pick<Platform, "readTextFile">, dir: string): Snapshot | undefined => {
  const value = readJson(files, paths(dir).snapshot) as Snapshot | undefined;
  return value && typeof value.at === "number" && value.status ? value : undefined;
};

export const readHistory = (files: Pick<Platform, "readTextFile">, dir: string): History => {
  const value = readJson(files, paths(dir).history);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as History) : {};
};

/** Read every device now and keep it as the snapshot (a request with no collector to answer it). */
export const readAndKeep = async ({ intentPath, platform, dir, now = Date.now }: { intentPath: string; platform: Platform; dir: string; now?: () => number }) => {
  const status = await readNetworkStatus({ intentPath, platform, now });
  if (!status) return undefined;
  const snapshot: Snapshot = { at: now(), status: { ...status, readAt: now() } };
  write(platform, dir, paths(dir).snapshot, snapshot);
  return snapshot;
};

type State = { history: History; counts: LineCounts; savedBucket?: number };

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
}): Promise<State> => {
  const status = await readNetworkStatus({ intentPath, platform, now });
  if (!status) return state;
  const at = now();
  const { counts, ...throughput } = throughputOf(status.internetCounters, state.counts);
  write(platform, dir, paths(dir).snapshot, { at, status: { ...status, throughput, readAt: at } } satisfies Snapshot);
  const history = withReadings(state.history, at, readingsOf(status, throughput), status.devices.map((d) => d.name));
  // Saved as each minute starts: a restart loses a minute at most, and a
  // router's RAM (or a Mac's disk) is written once a minute, not each read.
  const bucket = at - (at % bucketMs);
  if (bucket !== state.savedBucket) write(platform, dir, paths(dir).history, history);
  return { history, counts, savedBucket: bucket };
};

/** Read for as long as it runs (or until `stop` says so, for tests). */
export const runCollector = async ({
  intentPath,
  platform,
  dir,
  now = Date.now,
  tickMs = 2_000,
  stop = () => false,
}: {
  intentPath: string;
  platform: Platform;
  dir: string;
  now?: () => number;
  tickMs?: number;
  stop?: () => boolean;
}) => {
  let state: State = { history: readHistory(platform, dir), counts: {} };
  let lastRead = -Infinity;
  let lastError: string | undefined;
  while (!stop()) {
    const t = now();
    const wanted = readJson(platform, paths(dir).wanted);
    const watched = typeof wanted === "number" && t - wanted < watchingForMs;
    const every = watched ? watchedEveryMs : unwatchedEveryMs;
    if (t - lastRead >= every) {
      // An apply's devices are mid-change: leave them to it.
      const applying = (await jobState({ intentPath, files: platform }).catch(() => undefined))?.state === "running";
      if (!applying) {
        lastRead = t;
        try {
          state = await collectOnce({ intentPath, platform, dir, now, state });
          lastError = undefined;
        } catch (e) {
          // Said once, not every read (no intent yet, say).
          const error = String((e as Error)?.message ?? e);
          if (error !== lastError) console.error(`Reading status: ${error}`);
          lastError = error;
        }
      }
    }
    await platform.sleep(tickMs);
  }
  return state;
};
