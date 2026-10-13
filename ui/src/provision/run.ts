// A run as the Apply sheet shows it: where each device is among the steps
// every device goes through, and times in words. Pure: the components read it.
import type { DeviceStep } from "../../../src/applyEvents";

/** The steps every device goes through, in order, as a person reads them. */
export const stages = [
  { step: "planning", label: "Prepare" },
  { step: "configuring", label: "Configure" },
  { step: "committing", label: "Switch over" },
  { step: "confirming", label: "Confirm" },
] as const;

/** How far along a step is: -1 not started, 0..3 one of `stages`, 4 ended (however it ended). */
const reached: Record<DeviceStep, number> = {
  waiting: -1,
  planning: 0,
  configuring: 1,
  committing: 2,
  confirming: 3,
  confirmed: 4,
  reverted: 4,
  "rolling-back": 4,
  "rolled-back": 4,
  recovering: 4,
};

export type StageState = "done" | "current" | "next";

/** Each stage's state for a device at `step`. */
export const stageStates = (step: DeviceStep): StageState[] =>
  stages.map((_, i) => (i < reached[step] ? "done" : i === reached[step] ? "current" : "next"));

/** Whether a device's run has ended, one way or another. */
export const ended = (step: DeviceStep) => reached[step] === 4;

/** "2 min 10 s", "40 s". */
export const duration = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min${seconds % 60 ? ` ${seconds % 60} s` : ""}` : `${seconds} s`;
};

/** "1:05": a countdown's time left. */
export const clock = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

/** "14:03" (with seconds when asked), in this browser's time zone. */
export const timeOfDay = (ms: number, seconds = false) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}) });
