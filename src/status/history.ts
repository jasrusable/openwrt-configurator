// What the Status graphs draw, kept by the server: a few numbers per read
// (throughput, latency, clients online, each device's load and
// temperature), averaged into one point a minute, a day of them. Pure: the
// collector (collector.ts) holds it and saves it; pages read it whole once
// and then only what is new (`since`).
import { NetworkStatus } from "./network";

/** [minute's start, its mean, how many reads made it]. */
export type Point = [number, number, number];
export type History = Record<string, Point[]>;

export const bucketMs = 60_000;
export const keepMs = 24 * 3600_000;
/** Two byte counts further apart than this say nothing about the rate now. */
export const maxRateGapMs = 120_000;

/** A reading at `at`, averaged into its minute; points older than a day dropped. */
export const withSample = (history: History, key: string, at: number, value: number): History => {
  if (!Number.isFinite(value)) return history;
  const bucket = at - (at % bucketMs);
  const points = (history[key] ?? []).filter(([t]) => t > at - keepMs);
  const last = points[points.length - 1];
  const next: Point[] =
    last && last[0] === bucket
      ? [...points.slice(0, -1), [bucket, (last[1] * last[2] + value) / (last[2] + 1), last[2] + 1]]
      : last && last[0] > bucket
        ? points
        : [...points, [bucket, value, 1]];
  return { ...history, [key]: next };
};

/** The points of each series from `since` on (a minute still filling comes again, updated). */
export const historySince = (history: History, since: number): History =>
  Object.fromEntries(
    Object.entries(history)
      .map(([key, points]) => [key, points.filter(([t]) => t >= since - (since % bucketMs))] as const)
      .filter(([, points]) => points.length)
  );

/** What was held, with what is new in place of the minutes it repeats. */
export const mergeHistory = (kept: History, fresh: History, now = Date.now()): History =>
  Object.fromEntries(
    [...new Set([...Object.keys(kept), ...Object.keys(fresh)])].map((key) => {
      const update = fresh[key] ?? [];
      const from = update[0]?.[0] ?? Infinity;
      return [key, [...(kept[key] ?? []).filter(([t]) => t < from && t > now - keepMs), ...update]];
    })
  );

/**
 * Bits per second between two byte counts; undefined when they went
 * backwards (a restart) or are too far apart to say what it is now.
 */
export const rate = (before: { v: number; at: number } | undefined, now: { v: number; at: number }) =>
  before && now.at > before.at && now.at - before.at < maxRateGapMs && now.v >= before.v
    ? ((now.v - before.v) * 8) / ((now.at - before.at) / 1000)
    : undefined;

export type LineCounts = Record<string, { rx: number; tx: number; at: number }>;

/**
 * Throughput now, from each line's last count: each line's rate summed, so
 * one that has just come up counts from its next read rather than its whole
 * count landing at once.
 */
export const throughputOf = (
  counters: NetworkStatus["internetCounters"],
  before: LineCounts
): { down?: number; up?: number; counts: LineCounts } => {
  if (!counters) return { counts: before };
  const lines = Object.entries(counters.lines ?? {});
  const rates = lines.map(([id, now]) => {
    const was = before[id];
    return {
      rx: rate(was && { v: was.rx, at: was.at }, { v: now.rx, at: counters.at }),
      tx: rate(was && { v: was.tx, at: was.at }, { v: now.tx, at: counters.at }),
    };
  });
  const sum = (values: (number | undefined)[]) =>
    values.some((v) => v !== undefined) ? values.reduce<number>((a, v) => a + (v ?? 0), 0) : undefined;
  return {
    down: sum(rates.map((r) => r.rx)),
    up: sum(rates.map((r) => r.tx)),
    counts: Object.fromEntries(lines.map(([id, now]) => [id, { ...now, at: counters.at }])),
  };
};

/** The numbers one read adds to the graphs, by series. */
export const readingsOf = (status: NetworkStatus, throughput: { down?: number; up?: number }): Record<string, number> => ({
  ...(throughput.down !== undefined ? { down: throughput.down } : {}),
  ...(throughput.up !== undefined ? { up: throughput.up } : {}),
  ...(status.internetCheck?.latencyMs !== undefined ? { latency: status.internetCheck.latencyMs } : {}),
  ...(status.clientList ? { clients: status.clientList.filter((c) => c.state === "online").length } : {}),
  ...Object.fromEntries(
    (status.deviceViews ?? []).flatMap((d) => [
      ...(d.load !== undefined ? [[`load:${d.name}`, d.load / (d.cores ?? 1)] as const] : []),
      ...(d.temperature !== undefined ? [[`temperature:${d.name}`, d.temperature] as const] : []),
    ])
  ),
});

/** One read's numbers added; a device no longer in the settings keeps no history. */
export const withReadings = (history: History, at: number, readings: Record<string, number>, devices: string[]): History => {
  const kept = Object.fromEntries(
    Object.entries(history).filter(([key]) => !/^(load|temperature):/.test(key) || devices.includes(key.slice(key.indexOf(":") + 1)))
  );
  return Object.entries(readings).reduce((h, [key, value]) => withSample(h, key, at, value), kept);
};
