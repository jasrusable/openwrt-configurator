// What the Status graphs draw, kept by the server: a few numbers per read
// (throughput, latency, clients online, each device's load and
// temperature), averaged into points: one a minute for a day, and one every
// 15 minutes for 30 days. Pure: the collector (collector.ts) holds both and
// saves them; pages read a range whole once and then only what is new (`since`).
import { NetworkStatus } from "./network";

/** [the bucket's start, its mean, how many reads made it]. */
export type Point = [number, number, number];
export type History = Record<string, Point[]>;

/** How finely each range is kept, and for how long. */
export const ranges = {
  day: { bucketMs: 60_000, keepMs: 24 * 3600_000 },
  month: { bucketMs: 15 * 60_000, keepMs: 30 * 24 * 3600_000 },
} as const;
export type Range = keyof typeof ranges;
export type Histories = Record<Range, History>;
type RangeRule = (typeof ranges)[Range];

export const bucketMs = ranges.day.bucketMs;
export const keepMs = ranges.day.keepMs;
/** Two byte counts further apart than this say nothing about the rate now. */
export const maxRateGapMs = 120_000;

/** A reading at `at`, averaged into its bucket; points older than the range keeps dropped. */
export const withSample = (history: History, key: string, at: number, value: number, range: RangeRule = ranges.day): History => {
  if (!Number.isFinite(value)) return history;
  const bucket = at - (at % range.bucketMs);
  const points = (history[key] ?? []).filter(([t]) => t > at - range.keepMs);
  const last = points[points.length - 1];
  const next: Point[] =
    last && last[0] === bucket
      ? [...points.slice(0, -1), [bucket, (last[1] * last[2] + value) / (last[2] + 1), last[2] + 1]]
      : last && last[0] > bucket
        ? points
        : [...points, [bucket, value, 1]];
  return { ...history, [key]: next };
};

/** The points of each series from `since` on (a bucket still filling comes again, updated). */
export const historySince = (history: History, since: number, range: RangeRule = ranges.day): History =>
  Object.fromEntries(
    Object.entries(history)
      .map(([key, points]) => [key, points.filter(([t]) => t >= since - (since % range.bucketMs))] as const)
      .filter(([, points]) => points.length)
  );

/** What was held, with what is new in place of the buckets it repeats. */
export const mergeHistory = (kept: History, fresh: History, now = Date.now(), range: RangeRule = ranges.day): History =>
  Object.fromEntries(
    [...new Set([...Object.keys(kept), ...Object.keys(fresh)])].map((key) => {
      const update = fresh[key] ?? [];
      const from = update[0]?.[0] ?? Infinity;
      return [key, [...(kept[key] ?? []).filter(([t]) => t < from && t > now - range.keepMs), ...update]];
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

/**
 * One read's numbers added to a range, every series pruned to what the range
 * keeps (not only those read now: one no longer read, a line or a device gone
 * quiet, kept its days-old points); a device no longer in the settings keeps
 * no history.
 */
export const withReadings = (
  history: History,
  at: number,
  readings: Record<string, number>,
  devices: string[],
  range: RangeRule = ranges.day
): History => {
  const kept = Object.fromEntries(
    Object.entries(history).flatMap(([key, points]) => {
      if (/^(load|temperature):/.test(key) && !devices.includes(key.slice(key.indexOf(":") + 1))) return [];
      const recent = points.filter(([t]) => t > at - range.keepMs);
      return recent.length ? [[key, recent] as const] : [];
    })
  );
  return Object.entries(readings).reduce((h, [key, value]) => withSample(h, key, at, value, range), kept);
};

/** Means to four significant digits, as stored and served: the graphs draw no finer. */
export const rounded = (history: History): History =>
  Object.fromEntries(
    Object.entries(history).map(([key, points]) => [key, points.map(([t, mean, n]): Point => [t, Number(mean.toPrecision(4)), n])])
  );

/** One read's numbers added to every range. */
export const withReadingsEverywhere = (histories: Histories, at: number, readings: Record<string, number>, devices: string[]): Histories => ({
  day: withReadings(histories.day, at, readings, devices, ranges.day),
  month: withReadings(histories.month, at, readings, devices, ranges.month),
});
