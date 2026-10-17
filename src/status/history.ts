// What the Status graphs draw, kept by the server: a few numbers per read
// (throughput, latency and loss, each line up or down, clients online, each
// device's load, memory and temperature, each radio's clients and how busy
// its channel is), averaged into points: one a minute for a day, and one
// every 15 minutes for 30 days. A line's 1 (up) or 0 (down) averages into
// the share of the point it was up: the outage strip's cells. A point not
// there was not read: a gap, never good. Each client's signal, rate and
// traffic are kept apart, for a day at 10 minutes (`clientRange`), as there
// are many. Pure: the collector (collector.ts) holds them and saves them;
// pages read a range whole once and then only what is new (`since`).
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
export type RangeRule = { bucketMs: number; keepMs: number };

/** Each client's own series: a day, at 10 minutes (150 clients × 3 series × 144 points). */
export const clientRange: RangeRule = { bucketMs: 10 * 60_000, keepMs: 24 * 3600_000 };

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

/** A radio's series' name: by its access point and band, as SSIDs on one radio share its air. */
export const radioKey = (metric: "clients" | "busy", accessPoint: string, band: string) => `${metric}:${accessPoint}:${band}`;

/** The numbers one read adds to the graphs, by series. */
export const readingsOf = (status: NetworkStatus, throughput: { down?: number; up?: number }): Record<string, number> => {
  const check = status.internetCheck;
  // Lines are known only when the router was read: otherwise a gap, not a 0.
  const lines = status.internet
    ? status.connections.map((c) => [`line:${c.id}`, (c.line ? ["online", "disconnecting"].includes(c.line.state) : !!c.up) ? 1 : 0] as const)
    : [];
  const radios = (status.radios ?? []).filter((r) => r.band);
  const byRadio = [...new Set(radios.map((r) => `${r.accessPoint}\n${r.band}`))].map((id) => {
    const [accessPoint, band] = id.split("\n");
    const on = radios.filter((r) => r.accessPoint === accessPoint && r.band === band);
    const busy = on.flatMap((r) => (r.busy !== undefined ? [r.busy] : []));
    return [
      [radioKey("clients", accessPoint, band), on.reduce((sum, r) => sum + r.clients, 0)] as const,
      ...(busy.length ? [[radioKey("busy", accessPoint, band), Math.max(...busy)] as const] : []),
    ];
  });
  return {
    ...(throughput.down !== undefined ? { down: throughput.down } : {}),
    ...(throughput.up !== undefined ? { up: throughput.up } : {}),
    ...(check?.latencyMs !== undefined ? { latency: check.latencyMs } : {}),
    ...(check?.gatewayMs !== undefined ? { gateway: check.gatewayMs } : {}),
    ...(check?.lossPercent !== undefined ? { loss: check.lossPercent } : {}),
    ...(check?.jitterMs !== undefined ? { jitter: check.jitterMs } : {}),
    ...(status.internet ? { internet: status.internet.up ? 1 : 0 } : {}),
    ...Object.fromEntries(lines),
    ...(status.clientList ? { clients: status.clientList.filter((c) => c.state === "online").length } : {}),
    ...Object.fromEntries(
      (status.deviceViews ?? []).flatMap((d) => [
        ...(d.load !== undefined ? [[`load:${d.name}`, d.load / (d.cores ?? 1)] as const] : []),
        ...(d.memoryUsed !== undefined ? [[`memory:${d.name}`, d.memoryUsed] as const] : []),
        ...(d.temperature !== undefined ? [[`temperature:${d.name}`, d.temperature] as const] : []),
      ])
    ),
    ...Object.fromEntries(byRadio.flat()),
  };
};

/** The device a series belongs to, if it is one device's ("load:ap", "busy:ap:5 GHz"). */
const deviceOfKey = (key: string) => /^(?:load|memory|temperature|clients|busy):([^:]+)/.exec(key)?.[1];

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
      const device = deviceOfKey(key);
      if (device !== undefined && !devices.includes(device)) return [];
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

/** Each client's byte counts at a read (the router's month totals, else its access point's), for its rate at the next. */
export type ClientCounts = Record<string, { down: number; up: number; at: number }>;

/**
 * Each client's numbers this read (signal, the access point's rate to it,
 * its traffic since the last read in bits per second), and the counts the
 * next read takes its traffic from. A count that went backwards (a new month,
 * a new association) gives no rate this time.
 */
export const clientReadingsOf = (
  clients: NonNullable<NetworkStatus["clientList"]>,
  before: ClientCounts,
  at: number
): { readings: Record<string, number>; counts: ClientCounts } => {
  const online = clients.filter((c) => c.state === "online");
  const counts: ClientCounts = Object.fromEntries(
    online.flatMap((c) => (c.traffic ? [[c.mac, { down: c.traffic.down, up: c.traffic.up, at }] as const] : []))
  );
  const readings = Object.fromEntries(
    online.flatMap((c) => {
      const wifi = c.connection.kind === "wifi" ? c.connection : undefined;
      const was = before[c.mac];
      const now = counts[c.mac];
      const down = now && rate(was && { v: was.down, at: was.at }, { v: now.down, at });
      const up = now && rate(was && { v: was.up, at: was.at }, { v: now.up, at });
      return [
        ...(wifi?.signal !== undefined ? [[`signal:${c.mac}`, wifi.signal] as const] : []),
        ...(wifi?.txRate !== undefined ? [[`rate:${c.mac}`, wifi.txRate] as const] : []),
        ...(down !== undefined ? [[`down:${c.mac}`, down] as const] : []),
        ...(up !== undefined ? [[`up:${c.mac}`, up] as const] : []),
      ];
    })
  );
  return { readings, counts };
};

/** One read's client numbers added to theirs; a client unseen for a day ages out with its points. */
export const withClientReadings = (history: History, at: number, readings: Record<string, number>): History =>
  Object.entries(readings).reduce(
    (h, [key, value]) => withSample(h, key, at, value, clientRange),
    Object.fromEntries(
      Object.entries(history)
        .map(([key, points]) => [key, points.filter(([t]) => t > at - clientRange.keepMs)] as const)
        .filter(([, points]) => points.length)
    )
  );

/** One client's series, by their names without its MAC ("signal", "rate", "down", "up"). */
export const historyOfClient = (history: History, mac: string): History =>
  Object.fromEntries(
    Object.entries(history).flatMap(([key, points]) => {
      const i = key.indexOf(":");
      return key.slice(i + 1) === mac ? [[key.slice(0, i), points]] : [];
    })
  );

/** Each radio's channel counters at a read (ms the radio was on its channel, and of those, busy), for how busy it was by the next. */
export type RadioCounts = Record<string, { active: number; busy: number }>;

/** A radio's counters' name: its access point and interface. */
const radioId = (r: { accessPoint: string; ifname: string }) => `${r.accessPoint}\n${r.ifname}`;

/** A count this large wrapped (mt7915/mt7981 underflow their survey counters after days: mt76#1135; seen on an NWA50AX Pro). */
const wrapped = 1e15;

/**
 * How busy each radio's channel was since the last read, %, anyone's
 * traffic counted. The counters run on from when the radio came up on most
 * drivers, so it is the difference since the last read: right even where
 * mt76 wrapped one, as it counts on from there. Where they went backwards
 * (a radio restarted, or a driver that clears them when read) the counts
 * are themselves since then, if they can be right.
 */
export const airtimeOf = <R extends { accessPoint: string; ifname: string; airtime?: { active: number; busy: number } }>(
  radios: R[],
  before: RadioCounts
): { radios: (R & { busy?: number })[]; counts: RadioCounts } => {
  const counts: RadioCounts = Object.fromEntries(radios.flatMap((r) => (r.airtime ? [[radioId(r), r.airtime] as const] : [])));
  return {
    radios: radios.map((r) => {
      const now = r.airtime;
      if (!now) return r;
      const was = before[radioId(r)];
      const [active, busy] =
        was && now.active > was.active && now.busy >= was.busy
          ? [now.active - was.active, now.busy - was.busy]
          : was && now.busy <= now.active && now.active < wrapped
            ? [now.active, now.busy]
            : [0, 0];
      return active > 0 && busy <= active ? { ...r, busy: Math.round((busy / active) * 100) } : r;
    }),
    counts,
  };
};
