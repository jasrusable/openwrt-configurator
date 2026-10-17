// What an apply says about where it is, as data: each device's step and the
// run's outcome. The phases report them (src/apply, apply/provisionNetwork.ts);
// `provision --events <file>` writes them as JSON lines, and the UI shows
// them, so nothing reads the human log to find out.

/** A device's step, in order; the last three only when it does not apply. */
export const deviceSteps = [
  "waiting",
  "planning",
  "configuring",
  "committing",
  "confirming",
  "confirmed",
  // Nothing was committed: its staged change was simply dropped.
  "reverted",
  "rolling-back",
  "rolled-back",
  // It could not be reached to confirm its rollback: it finishes on its own (a reboot, if need be).
  "recovering",
] as const;
export type DeviceStep = (typeof deviceSteps)[number];

export const applyOutcomes = ["applied", "applied-with-problems", "rolled-back", "partial", "failed", "plan-stale"] as const;
export type ApplyOutcome = (typeof applyOutcomes)[number];

/**
 * The run's safety window, once every device is armed: confirming must be
 * done by `confirmBy` (the earliest watchdog's deadline), and by `restoredBy`
 * every device not confirmed has put its previous settings back on its own
 * (the latest deadline, plus the time its watchdog waits to hear the old
 * config works before it reboots onto it).
 */
export type ApplyWindow = { confirmBy: number; restoredBy: number };

/** A device's firmware upgrade, before the apply that follows it (src/firmware/upgrade.ts). */
export const firmwareSteps = ["building", "downloading", "checking", "flashing", "rebooting", "upgraded", "failed"] as const;
export type FirmwareStep = (typeof firmwareSteps)[number];

export type ApplyEvent =
  | { at: number; device: string; step: DeviceStep }
  | { at: number; device: string; firmware: FirmwareStep }
  | { at: number; outcome: ApplyOutcome }
  | { at: number; window: ApplyWindow };

export type Reporter = (event: ApplyEvent) => void;

/** Reporting nowhere: the CLI without --events, and tests. */
export const silent: Reporter = () => {};

export type ApplyProgress = {
  /** Each device's latest step. */
  devices: Record<string, DeviceStep>;
  outcome?: ApplyOutcome;
  /** "partial": the devices that kept the change. */
  kept?: string[];
  window?: ApplyWindow;
  /** When the run reported first, and when it said how it ended. */
  startedAt?: number;
  endedAt?: number;
  /** Each device's first and latest report: how long it took. */
  times?: Record<string, { from: number; to: number }>;
  /** Each upgraded device's firmware step, when the run upgrades first. */
  firmware?: Record<string, FirmwareStep>;
};

/** The events, as where things stand. Unknown lines (another version's) are skipped. */
const isWindow = (value: unknown): value is ApplyWindow =>
  !!value &&
  typeof value === "object" &&
  typeof (value as ApplyWindow).confirmBy === "number" &&
  typeof (value as ApplyWindow).restoredBy === "number";

export const progressOf = (events: unknown[]): ApplyProgress =>
  events.reduce<ApplyProgress>((progress, event) => {
    if (!event || typeof event !== "object") return progress;
    const e = event as Record<string, unknown>;
    const at = typeof e.at === "number" ? e.at : undefined;
    const seen = at === undefined || progress.startedAt !== undefined ? progress : { ...progress, startedAt: at };
    if (typeof e.device === "string" && deviceSteps.includes(e.step as DeviceStep)) {
      const was = seen.times?.[e.device];
      return {
        ...seen,
        devices: { ...seen.devices, [e.device]: e.step as DeviceStep },
        ...(at === undefined ? {} : { times: { ...seen.times, [e.device]: { from: was?.from ?? at, to: at } } }),
      };
    }
    if (applyOutcomes.includes(e.outcome as ApplyOutcome)) {
      const kept = Array.isArray(e.kept) ? e.kept.filter((name): name is string => typeof name === "string") : undefined;
      return { ...seen, outcome: e.outcome as ApplyOutcome, ...(kept ? { kept } : {}), ...(at === undefined ? {} : { endedAt: at }) };
    }
    if (isWindow(e.window)) return { ...seen, window: e.window };
    if (typeof e.device === "string" && firmwareSteps.includes(e.firmware as FirmwareStep)) {
      return { ...seen, firmware: { ...seen.firmware, [e.device]: e.firmware as FirmwareStep } };
    }
    return seen;
  }, { devices: {} });

/** JSON lines, one event each; a line cut off mid-write is skipped. */
export const parseEvents = (text: string): unknown[] =>
  text.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
