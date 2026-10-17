// One loop owns reading the devices for the Status pages: it reads them all
// (read.ts), keeps the result as a snapshot every page answers from at once,
// adds its numbers to the graphs' history (history.ts), tells what changed
// since the last read as events (events.ts), and remembers every client
// seen (registry.ts) and where each went (moves.ts). Fast while someone has the app open (each status
// request leaves a mark), slow otherwise, so the graphs have no gaps; never
// while an apply runs. On a Mac it runs inside `onc ui`, writing beside the
// intent; on a router it is its own service (`onc collect`), writing to RAM,
// which the CGI reads, and copying what is worth keeping to flash every hour
// and as it stops (`persistDir`), from where it starts again.
import { z } from "zod";
import { Platform } from "../platform";
import { fail, Problem, problem } from "../problem";
import { Result, attempt, map, messageOf, ok } from "../result";
import { jobProgress, jobState } from "../server/provisionJob";
import { read, StoreFiles, StoreKey, tryWrite, write } from "../store";
import { eventSchema, eventsBetween, keepEvents, NetworkEvent, Observed, observe } from "./events";
import {
  airtimeOf,
  bucketMs,
  ClientCounts,
  clientReadingsOf,
  Histories,
  History,
  LineCounts,
  RadioCounts,
  Range,
  readingsOf,
  throughputOf,
  withClientReadings,
  withReadingsEverywhere,
} from "./history";
import { NetworkStatus } from "./network";
import { readNetworkStatus, readStatusSettings } from "./read";
import { Registry, registrySchema, updateRegistry, withRegistry } from "./registry";
import { Moves, movesSchema, updateMoves } from "./moves";

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
/** Each client's own series (history.ts, `clientRange`). */
const clientHistoryKey = (dir: string): StoreKey<History> => ({
  path: `${dir}/client-history.json`,
  schema: z.custom<History>((v) => !!v && typeof v === "object" && !Array.isArray(v)),
  format: 1,
});
export const eventsKey = (dir: string): StoreKey<NetworkEvent[]> => ({ path: `${dir}/events.json`, schema: z.array(eventSchema), format: 1 });
export const registryKey = (dir: string): StoreKey<Registry> => ({ path: `${dir}/clients.json`, schema: registrySchema, format: 1 });
export const movesKey = (dir: string): StoreKey<Moves> => ({ path: `${dir}/client-moves.json`, schema: movesSchema, format: 1 });

/** What a router copies to flash: everything that is history, never the snapshot (read again in seconds). */
const persisted = (dir: string): StoreKey<unknown>[] => [
  historyKey(dir, "day"),
  historyKey(dir, "month"),
  clientHistoryKey(dir),
  eventsKey(dir),
  registryKey(dir),
  movesKey(dir),
];

/** How many events the snapshot carries: the latest; the rest are asked for (GET /api/events). */
export const eventsInSnapshot = 200;

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

export const readClientHistory = (files: Pick<Platform, "readTextFile">, dir: string): History => read(files, clientHistoryKey(dir)) ?? {};

export const readEvents = (files: Pick<Platform, "readTextFile">, dir: string): NetworkEvent[] => read(files, eventsKey(dir)) ?? [];

export const readRegistry = (files: Pick<Platform, "readTextFile">, dir: string): Registry | undefined => read(files, registryKey(dir));

export const readMoves = (files: Pick<Platform, "readTextFile">, dir: string): Moves | undefined => read(files, movesKey(dir));

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

/** Read every device now and keep it as the snapshot (a request with no collector to answer it): with the events and clients kept, unchanged. */
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
    const at = now();
    const snapshot: Snapshot = {
      at,
      status: {
        ...status,
        ...(status.clientList ? { clientList: withRegistry(status.clientList, readRegistry(platform, dir), at, reservedIn(status)) } : {}),
        events: readEvents(platform, dir).slice(0, eventsInSnapshot),
        readAt: at,
      },
    };
    write(platform, snapshotKey(dir), snapshot);
    return snapshot;
  });

/** Whether a MAC has a fixed address: as the clients read say (a remembered one away may too). */
const reservedIn = (status: NetworkStatus) => {
  const macs = new Set(status.reservations ?? []);
  return (mac: string) => macs.has(mac);
};

export type State = {
  histories: Histories;
  counts: LineCounts;
  savedBucket?: number;
  clientHistory?: History;
  clientCounts?: ClientCounts;
  radioCounts?: RadioCounts;
  observed?: Observed;
  registry?: Registry;
  moves?: Moves;
  events?: NetworkEvent[];
  /** The last apply told as an event, by when it started. */
  applyTold?: number;
};

/** This app's own last run, as an event once it has ended: applied, or not. */
const applyEvent = async (intentPath: string, platform: Platform, told: number | undefined): Promise<NetworkEvent | undefined> => {
  const run = await jobState({ intentPath, files: platform }).catch(() => undefined);
  if (!run?.startedAt || run.startedAt === told || run.state === "running" || run.state === "idle") return undefined;
  const outcome = jobProgress(intentPath, platform).outcome;
  const [severity, text]: [NetworkEvent["severity"], string] =
    run.state === "succeeded"
      ? ["ok", "Settings applied"]
      : run.state === "applied-with-problems"
        ? ["warning", "Settings applied, with a problem after"]
        : outcome === "rolled-back"
          ? ["problem", "An apply was rolled back: every device kept its settings"]
          : ["problem", "An apply stopped before changing anything"];
  return { at: run.startedAt, kind: "apply", severity, subject: "app:apply", text };
};

/** A new client, as an event. */
const newClientEvent = (c: { mac: string; firstSeen: number; name?: string; network?: string; accessPoint?: string }, networkName: (id: string) => string | undefined): NetworkEvent => ({
  at: c.firstSeen,
  kind: "client",
  severity: "info",
  subject: `client:${c.mac}`,
  ...(c.accessPoint ? { device: c.accessPoint } : {}),
  text: `New device: ${c.name ?? c.mac}${c.network && networkName(c.network) ? ` on ${networkName(c.network)}` : ""}`,
});

/**
 * What one read makes, given what the reads before left: the snapshot (with
 * the throughput since the last, how busy each radio's channel was, every
 * client remembered, the latest events), and what the next read takes on.
 * Pure: `collectOnce` reads and writes around it.
 */
export const digest = ({
  read,
  at,
  state,
  networkName = () => undefined,
  applied,
}: {
  read: NetworkStatus;
  at: number;
  state: State;
  /** A network's name, by id, for a new client's event. */
  networkName?: (id: string) => string | undefined;
  /** This app's last run, when it has just ended (an event). */
  applied?: NetworkEvent;
}): { snapshot: Snapshot; state: State } => {
  const { counts, ...throughput } = throughputOf(read.internetCounters, state.counts);
  const air = airtimeOf(read.radios ?? [], state.radioCounts ?? {});
  const status: NetworkStatus = { ...read, radios: air.radios, throughput, readAt: at };
  const reserved = reservedIn(status);
  const { registry, fresh } = updateRegistry({ registry: state.registry, clients: status.clientList ?? [], at, keep: reserved });
  const moves = updateMoves({ moves: state.moves, clients: status.clientList ?? [], at, remembered: (mac) => !!registry.clients[mac] });
  const observed = observe(status, at, state.observed);
  const fresher = [...eventsBetween(state.observed, observed), ...fresh.map((c) => newClientEvent(c, networkName)), ...(applied ? [applied] : [])];
  const before = state.events ?? [];
  const events = fresher.length ? keepEvents(before, fresher, at) : before;
  const clientList = status.clientList && withRegistry(status.clientList, registry, at, reserved);
  const clientReadings = clientReadingsOf(status.clientList ?? [], state.clientCounts ?? {}, at);
  return {
    snapshot: { at, status: { ...status, ...(clientList ? { clientList } : {}), events: events.slice(0, eventsInSnapshot) } },
    state: {
      ...state,
      histories: withReadingsEverywhere(state.histories, at, readingsOf(status, throughput), status.devices.map((d) => d.name)),
      counts,
      clientHistory: withClientReadings(state.clientHistory ?? {}, at, clientReadings.readings),
      clientCounts: clientReadings.counts,
      radioCounts: air.counts,
      observed,
      registry,
      moves,
      events,
      applyTold: applied?.at ?? state.applyTold,
    },
  };
};

/** One read: digested, the snapshot written at once, what changed in events written as it changes, the rest once a minute. */
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
  const at = now();
  const settings = await readStatusSettings(intentPath, platform);
  const networkName = (id: string) => (settings.ok ? settings.value.intent.networks.find((n) => n.id === id)?.name : undefined);
  const applied = await applyEvent(intentPath, platform, state.applyTold);
  const { snapshot, state: next } = digest({ read: read.value, at, state, networkName, ...(applied ? { applied } : {}) });
  write(platform, snapshotKey(dir), snapshot);
  if (next.events !== state.events) tryWrite(platform, eventsKey(dir), next.events ?? []);
  // Saved as each minute starts: a restart loses a minute at most, and a
  // router's RAM (or a Mac's disk) is written once a minute, not each read.
  const bucket = at - (at % bucketMs);
  if (bucket !== state.savedBucket) {
    write(platform, historyKey(dir, "day"), next.histories.day);
    write(platform, historyKey(dir, "month"), next.histories.month);
    write(platform, clientHistoryKey(dir), next.clientHistory ?? {});
    if (next.registry) write(platform, registryKey(dir), next.registry);
    if (next.moves) write(platform, movesKey(dir), next.moves);
  }
  return ok({ ...next, savedBucket: bucket });
};

/**
 * What is worth keeping, copied from `from` to `to`, each that is there:
 * on a router, from RAM to flash, and back at the next start where RAM has
 * none (a reboot). A copy that fails is tried again next time.
 */
export const copyKept = (platform: StoreFiles, from: string, to: string, onlyMissing = false) => {
  const targets = persisted(to);
  persisted(from).forEach((key, i) => {
    const value = read(platform, key);
    if (value === undefined || (onlyMissing && read(platform, targets[i]) !== undefined)) return;
    tryWrite(platform, targets[i] as StoreKey<unknown>, value);
  });
};

/** Read for as long as it runs (or until `stop` says so, for tests). */
export const runCollector = async ({
  intentPath,
  platform,
  dir,
  persistDir,
  now = Date.now,
  tickMs = 2_000,
  stop = () => false,
  collect = collectOnce,
  everyHour,
}: {
  intentPath: string;
  platform: Platform;
  dir: string;
  /** Where what is worth keeping is copied every hour and as it stops (a router's flash), and taken from at the start. */
  persistDir?: string;
  now?: () => number;
  tickMs?: number;
  stop?: () => boolean;
  /** One read (tests give their own). */
  collect?: typeof collectOnce;
  /** Work done once an hour beside the reads: asking OpenWrt for its releases (it asks at most once a day). */
  everyHour?: () => Promise<unknown>;
}) => {
  const keeping = persistDir && persistDir !== dir ? persistDir : undefined;
  if (keeping) {
    copyKept(platform, keeping, dir, true);
    // Stopped (procd's stop, a reboot): the last hour kept too.
    platform.onStop(() => copyKept(platform, dir, keeping));
  }
  const registry = readRegistry(platform, dir);
  const moves = readMoves(platform, dir);
  let state: State = {
    histories: readHistories(platform, dir),
    counts: {},
    clientHistory: readClientHistory(platform, dir),
    events: readEvents(platform, dir),
    ...(registry ? { registry } : {}),
    ...(moves ? { moves } : {}),
  };
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
    if (t - lastHourly >= 3_600_000) {
      // Not at the start: what it would copy is what was just taken from there.
      if (keeping && lastHourly !== -Infinity) copyKept(platform, dir, keeping);
      lastHourly = t;
      // Its own failures are its own: a missed ask is asked next hour.
      if (everyHour) await attempt(everyHour, () => undefined);
    }
    await platform.sleep(tickMs);
  }
  return state;
};
