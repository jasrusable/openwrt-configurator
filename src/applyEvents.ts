// What an apply says about where it is, as data: each device's step and the
// run's outcome. The phases report them (devicePhases.ts, provisionNetwork.ts);
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

export const applyOutcomes = ["applied", "applied-with-problems", "rolled-back", "failed"] as const;
export type ApplyOutcome = (typeof applyOutcomes)[number];

export type ApplyEvent =
  | { at: number; device: string; step: DeviceStep }
  | { at: number; outcome: ApplyOutcome };

export type Reporter = (event: ApplyEvent) => void;

/** Reporting nowhere: the CLI without --events, and tests. */
export const silent: Reporter = () => {};

export type ApplyProgress = {
  /** Each device's latest step. */
  devices: Record<string, DeviceStep>;
  outcome?: ApplyOutcome;
};

/** The events, as where things stand. Unknown lines (another version's) are skipped. */
export const progressOf = (events: unknown[]): ApplyProgress =>
  events.reduce<ApplyProgress>((progress, event) => {
    if (!event || typeof event !== "object") return progress;
    const e = event as Record<string, unknown>;
    if (typeof e.device === "string" && deviceSteps.includes(e.step as DeviceStep)) {
      return { ...progress, devices: { ...progress.devices, [e.device]: e.step as DeviceStep } };
    }
    if (applyOutcomes.includes(e.outcome as ApplyOutcome)) return { ...progress, outcome: e.outcome as ApplyOutcome };
    return progress;
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
