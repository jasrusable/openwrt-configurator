// Each step a run reports for a device (src/applyEvents.ts), in words, for the
// Apply sheet's device rows.
import type { DeviceStep } from "../../../src/applyEvents";

export type Progress = { label: string; tone: "gray" | "blue" | "green" | "orange" | "red" };

export const progressOf: Record<DeviceStep, Progress> = {
  waiting: { label: "Waiting", tone: "gray" },
  planning: { label: "Getting ready…", tone: "blue" },
  configuring: { label: "Setting up…", tone: "blue" },
  committing: { label: "Switching over…", tone: "blue" },
  confirming: { label: "Checking it is reachable…", tone: "blue" },
  // The device was reached again and kept the change. "Done" does not say what finished.
  confirmed: { label: "Applied", tone: "green" },
  reverted: { label: "Not changed", tone: "gray" },
  "rolling-back": { label: "Rolling back…", tone: "orange" },
  "rolled-back": { label: "Rolled back", tone: "orange" },
  recovering: { label: "Rolling back on its own", tone: "orange" },
};
