// The OpenWrt releases this tool provisions. It drives apk, OpenWrt's package
// manager from 25.12 on (and in snapshots since late 2024); older releases
// have opkg and other package names, so a device on one is refused before
// anything is touched, rather than failing partway, at the package step.
/** The oldest release this tool supports: a patch fixed before it is one to drop. */
export const oldestSupportedRelease = "25.12.0";

export const supportedRelease = (version: string) => {
  if (/^SNAPSHOT/i.test(version)) return true;
  const match = /^(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 25 || (major === 25 && minor >= 12);
};

export const assertSupportedRelease = (hostname: string, version: string) => {
  if (!supportedRelease(version)) {
    throw new Error(
      `${hostname} runs OpenWrt ${version}; this tool needs 25.12 or later ` +
        `(it installs packages with apk). build-images can make an image to upgrade it.`
    );
  }
};

/** "25.12.5" → [25, 12, 5, 0]; a release candidate sorts before its release, a snapshot after every release of its line. */
const releaseOrder = (version: string) => {
  if (/^SNAPSHOT/i.test(version)) return [Infinity];
  const match = /^(\d+(?:\.\d+)*)(?:-(.+))?$/.exec(version.trim());
  if (!match) return undefined;
  const numbers = match[1].split(".").map(Number);
  const suffix = match[2] ?? "";
  if (/snapshot/i.test(suffix)) return [...numbers, Infinity];
  const rc = /^rc(\d+)$/i.exec(suffix);
  if (suffix && !rc) return undefined;
  // Pad so 25.12 and 25.12.0 compare equal; the release itself ranks after its rcs.
  return [...numbers, ...Array(4 - Math.min(numbers.length, 4)).fill(0), rc ? -1000 + Number(rc[1]) : 0];
};

/** Negative, zero or positive as release a is older than, the same as or newer than b; undefined when either is not a release. */
export const compareReleases = (a: string, b: string) => {
  const [x, y] = [releaseOrder(a), releaseOrder(b)];
  if (!x || !y) return undefined;
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const [p, q] = [x[i] ?? 0, y[i] ?? 0];
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
};

/** "25.12.5" → "25.12": the series a release belongs to (its fixes, never its changes). */
export const seriesOf = (version: string) => /^(\d+\.\d+)/.exec(version)?.[1];

/** A series as the firmware settings name one ("25.12": its newest release). */
export const isSeries = (version: string) => /^\d+\.\d+$/.test(version);

/** One stable release ("25.12.5"): not a series, a candidate or a snapshot. */
export const isStableRelease = (version: string) => /^\d+\.\d+\.\d+$/.test(version);

/**
 * The newest series this app has been checked against: an upgrade into a
 * newer one carries the settings over unchecked, so it is acknowledged first.
 * Raised once a series has been through the rig and the patches' ranges.
 */
export const newestCheckedSeries = "25.12";

/** Whether a release is of a series newer than this app has been checked against. */
export const uncheckedSeries = (version: string) => (compareReleases(seriesOf(version) ?? version, newestCheckedSeries) ?? 0) > 0;

/** The release `ubus call system board` names, undefined when it names none. */
export const boardRelease = ({ stdout, code }: { stdout: string; code: number | null }): string | undefined => {
  if (code !== 0) return undefined;
  try {
    const version = (JSON.parse(stdout) as { release?: { version?: unknown } } | null)?.release?.version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
};
