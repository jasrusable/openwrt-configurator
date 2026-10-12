// Where the devices stand against the saved settings, in words: the header
// beside Apply and the Apply page's Status both say it from here.
import type { ProvisionInfo } from "../data/api";

export type ApplyStatus = {
  /** A few words, for the header. */
  short: string;
  /** The Status row's label and explanation. */
  title: string;
  detail: string;
  color: "blue" | "orange" | "green" | "gray";
  /** Whether there is something to apply. */
  pending: boolean;
};

export const applyStatus = (info: ProvisionInfo): ApplyStatus => {
  const n = info.changes.length;
  if (info.state === "running") {
    return {
      short: "Applying…",
      title: "Applying",
      detail: "Your devices are being reconfigured: progress is below.",
      color: "blue",
      pending: false,
    };
  }
  switch (info.live) {
    case "none":
      return {
        short: "Not applied yet",
        title: "Not applied from here yet",
        detail: "Applying sets up every device from the whole configuration.",
        color: "gray",
        pending: true,
      };
    case "differs":
      return {
        short: `${n} change${n === 1 ? "" : "s"} to apply`,
        title: `${n} change${n === 1 ? "" : "s"} to apply`,
        detail: "Saved here, but not on your devices yet.",
        color: "orange",
        pending: true,
      };
    case "matches":
      return {
        short: "Up to date",
        title: "Up to date",
        detail: "Your devices have these settings.",
        color: "green",
        pending: false,
      };
  }
};

/** How the last run went, if there was one and it is over. */
export const lastRun = (state: ProvisionInfo["state"]) =>
  ({
    succeeded: { title: "Last run succeeded", color: "green" },
    failed: { title: "Last run failed: every device rolled back", color: "red" },
    interrupted: { title: "Last run was interrupted", color: "red" },
  } as Partial<Record<ProvisionInfo["state"], { title: string; color: string }>>)[state];
