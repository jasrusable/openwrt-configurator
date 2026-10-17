// Which OpenWrt each device should run, from the settings (system.firmware,
// hardware.*.firmware) and the releases OpenWrt has out (releases.ts), and
// where each stands against what it runs (its facts). Pure: the Firmware tab
// works it out from the draft, so a change shows at once. A series names its
// newest release and never the next series's: moving to one is a choice.
import type { Intent } from "../intent/schema";
import { compareReleases, isSeries, oldestSupportedRelease, seriesOf, uncheckedSeries } from "../release";

/** OpenWrt's stable releases by series, newest first, as ASU builds them; when they were read. */
export type Releases = { at: number; series: Record<string, string[]> };

/** The series a network follows when its settings name none: the oldest this app supports. */
export const defaultSeries = seriesOf(oldestSupportedRelease)!;

/** The network's choice: "stable" (the newest of any series), a series, or one release. */
export const networkRelease = (intent: Pick<Intent, "system">) => intent.system.firmware?.release ?? defaultSeries;

export type Target =
  /** Never upgraded (hardware.*.firmware "hold"). */
  | { kind: "hold" }
  /**
   * `pinned`: the device's own, not the network's. `follows`: the series (or
   * "stable") it was taken from, as the newest read: never one to move back to.
   */
  | { kind: "release"; version: string; pinned: boolean; follows?: string }
  /** A series (or "stable") whose releases have not been read yet. */
  | { kind: "unknown"; series: string };

/** What a device should run. */
export const targetOf = (intent: Pick<Intent, "system" | "hardware">, device: string, releases?: Releases): Target => {
  const own = intent.hardware.find((d) => d.name === device)?.firmware;
  if (own === "hold") return { kind: "hold" };
  if (own) return { kind: "release", version: own, pinned: true };
  const wanted = networkRelease(intent);
  if (wanted !== "stable" && !isSeries(wanted)) return { kind: "release", version: wanted, pinned: false };
  const newest = wanted === "stable" ? newestStable(releases) : releases?.series[wanted]?.[0];
  return newest ? { kind: "release", version: newest, pinned: false, follows: wanted } : { kind: "unknown", series: wanted };
};

/** The newest stable release of any series (candidates and snapshots never count: releases.ts keeps neither). */
export const newestStable = (releases?: Releases) =>
  Object.values(releases?.series ?? {})
    .flat()
    .sort((a, b) => compareReleases(b, a) ?? 0)[0];

export type FirmwareState =
  /** Its facts have not been read: what it runs is not known. */
  | "not-read"
  | "held"
  | "unknown"
  | "current"
  | "update"
  /** It runs something newer than a release named for it: moved back only when acknowledged (upgradePlan.ts). */
  | "downgrade";

export type FirmwareRow = { device: string; running?: string; target: Target; state: FirmwareState };

/** What a device runs, as its facts say (the model too, for the table). */
export type RunningFacts = Record<string, { version: string } | undefined>;

const stateOf = (running: string | undefined, target: Target): FirmwareState => {
  if (target.kind === "hold") return "held";
  if (!running) return "not-read";
  if (target.kind === "unknown") return "unknown";
  const order = compareReleases(running, target.version);
  if (order === undefined) return "unknown";
  // Ahead of the newest read of what it follows (releases read before, or
  // moved by hand) is where following leaves it: only a release named for
  // it, pinned or the network's, takes it back.
  return order < 0 ? "update" : order > 0 && !target.follows ? "downgrade" : "current";
};

/** Each device in Hardware, where it stands. */
export const firmwareRows = ({
  intent,
  facts,
  releases,
}: {
  intent: Pick<Intent, "system" | "hardware">;
  facts: RunningFacts;
  releases?: Releases;
}): FirmwareRow[] =>
  intent.hardware.map(({ name }) => {
    const running = facts[name]?.version;
    const target = targetOf(intent, name, releases);
    return { device: name, ...(running ? { running } : {}), target, state: stateOf(running, target) };
  });

/** Series newer than the one the network follows: out, but only moved to by choosing one (or "stable", which follows them). */
export const newerSeries = (intent: Pick<Intent, "system">, releases?: Releases) => {
  const wanted = networkRelease(intent);
  if (wanted === "stable") return [];
  const current = seriesOf(wanted) ?? defaultSeries;
  return Object.keys(releases?.series ?? {})
    .filter((series) => (compareReleases(series, current) ?? 0) > 0 && releases!.series[series].length > 0)
    .sort((a, b) => compareReleases(b, a) ?? 0);
};

/**
 * Whether updates are available, as every indicator says it (the sidebar,
 * System's tabs, the Firmware tab, Overview, a device's page): the newest
 * release some device can move up to, which devices, and the words for it.
 * None until OpenWrt's releases have been read, and none when nothing can.
 */
export const updatesAvailable = (rows: FirmwareRow[], releases?: Releases) => {
  if (!releases) return undefined;
  const behind = rows.flatMap((r) => (r.state === "update" && r.target.kind === "release" ? [{ device: r.device, version: r.target.version }] : []));
  const version = behind.map((b) => b.version).sort((a, b) => compareReleases(b, a) ?? 0)[0];
  if (!version) return undefined;
  const devices = behind.map((b) => b.device);
  const text = `OpenWrt ${version} is out: ${devices.length} device${devices.length === 1 ? "" : "s"} can update.`;
  return { version, devices, text };
};

/**
 * What an upgrade of the rows that would move must have acknowledged, as the
 * Firmware tab ticks it and the server checks it: each device moved back, to
 * which release, and each series moved into that this app has not been
 * checked against. A tick is for exactly these: any other is ticked again.
 */
export const acknowledgementsOf = (moving: FirmwareRow[]) => ({
  downgrades: Object.fromEntries(
    moving.flatMap((r) => (r.state === "downgrade" && r.target.kind === "release" ? [[r.device, r.target.version]] : []))
  ) as Record<string, string>,
  newSeries: [
    ...new Set(moving.flatMap((r) => (r.target.kind === "release" && uncheckedSeries(r.target.version) ? [seriesOf(r.target.version)!] : []))),
  ].sort(),
});
export type Acknowledgements = ReturnType<typeof acknowledgementsOf>;

/** The rows an upgrade of `only` (every one, unset) would move. */
export const movingRows = (rows: FirmwareRow[], only?: string[]) =>
  rows.filter((r) => (r.state === "update" || r.state === "downgrade") && (!only || only.includes(r.device)));

/**
 * The settings an upgrade leaves alone: which release each device should
 * run. They compile to nothing on a device, so saved but not applied they
 * are no change an upgrade's apply would send unreviewed.
 */
export const isFirmwareChoice = (path: string) => /^system\.firmware(\.|$)|^hardware\.\d+\.firmware$/.test(path);

/**
 * The order devices are flashed in, the run's and the Firmware tab's alike:
 * mesh repeaters, then cabled access points, then the router (every other
 * device reaches the network through it), and the device this app runs on
 * last of all (the run ends with it). Order within each is kept.
 */
export const inFlashOrder = <T>(intent: Pick<Intent, "hardware">, items: T[], deviceOf: (item: T) => string, host?: string) => {
  const rank = (device: string) => {
    const d = intent.hardware.find((h) => h.name === device);
    return device === host ? 3 : d?.role === "router" ? 2 : d?.uplink === "mesh" ? 0 : 1;
  };
  return [...items].sort((a, b) => rank(deviceOf(a)) - rank(deviceOf(b)));
};

/** OpenWrt's release notes for a release (25.12.5's under 25.12). */
export const releaseNotesUrl = (version: string) => `https://openwrt.org/releases/${seriesOf(version)}/notes-${version}`;
