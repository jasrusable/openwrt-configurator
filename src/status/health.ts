// How good a reading is, in four words every Status page uses alike: good,
// fair, poor, or off (unknown, not read). The thresholds are written once,
// here, and the pages colour a value by them (docs/status-redesign.md's
// table). A client's health names its cause, never an opaque score. Pure.
import type { ClientView, RadioView } from "./views";

export type Tone = "good" | "fair" | "poor" | "off";

/** Where each reading turns fair, and then poor. */
export const thresholds = {
  /** dBm, at least. */
  signal: { good: -67, fair: -75 },
  /** % of the channel busy, below. */
  busy: { good: 30, fair: 60 },
  /** Round trip, ms, below. */
  latency: { good: 30, fair: 80 },
  /** Lost, %, at most. */
  loss: { good: 0, fair: 2 },
  /** ms, below. */
  jitter: { good: 10, fair: 30 },
  /** Load per core, below. */
  load: { good: 0.7, fair: 0.9 },
  /** °C, below. */
  temperature: { good: 70, fair: 85 },
  /** Share of memory used, below. */
  memory: { good: 0.8, fair: 0.9 },
  /** Added round trip under load, ms, below: A and B good, C fair. */
  bloat: { good: 30, fair: 60 },
} as const;

type Scale = { good: number; fair: number };

/** A reading where more is worse (latency, load): good below `good`, fair below `fair`. */
const below = (value: number | undefined, { good, fair }: Scale): Tone =>
  value === undefined || !Number.isFinite(value) ? "off" : value < good ? "good" : value < fair ? "fair" : "poor";

/** A reading where more is better (signal): good from `good` up, fair from `fair` up. */
const atLeast = (value: number | undefined, { good, fair }: Scale): Tone =>
  value === undefined || !Number.isFinite(value) ? "off" : value >= good ? "good" : value >= fair ? "fair" : "poor";

export const tone = {
  signal: (dbm?: number) => atLeast(dbm, thresholds.signal),
  busy: (percent?: number) => below(percent, thresholds.busy),
  latency: (ms?: number) => below(ms, thresholds.latency),
  loss: (percent?: number) =>
    percent === undefined ? "off" : percent <= thresholds.loss.good ? "good" : percent < thresholds.loss.fair ? "fair" : "poor",
  jitter: (ms?: number) => below(ms, thresholds.jitter),
  load: (perCore?: number) => below(perCore, thresholds.load),
  temperature: (celsius?: number) => below(celsius, thresholds.temperature),
  memory: (used?: number) => below(used, thresholds.memory),
  bloat: (addedMs?: number) => below(addedMs, thresholds.bloat),
} satisfies Record<string, (value?: number) => Tone>;

const rank: Record<Tone, number> = { off: 0, good: 1, fair: 2, poor: 3 };

/** The worst of several, ignoring what is not known; off when nothing is. */
export const worst = (...tones: Tone[]): Tone => tones.reduce<Tone>((w, t) => (rank[t] > rank[w] ? t : w), "off");

/** A stronger access point by this much (dB) is worth moving to. */
export const roamGainDb = 10;
/** On 2.4 GHz while a 5 or 6 GHz radio hears it at least this well: it could use the faster band. */
const otherBandUsable = -70;

export type ClientHealth = { tone: Tone; causes: { tone: Tone; text: string }[] };

/**
 * How a client is served, and why not well: its signal, its channel's air,
 * whether it sits on 2.4 GHz with a faster band in reach, whether another
 * access point hears it clearly better. The link's rate is shown, never
 * judged: an idle link drops to 1 or 6 Mbit/s at any signal (seen on a real
 * access point at −48 dBm), so a low rate says nothing without traffic.
 */
export const clientHealth = (client: ClientView, radios: RadioView[] = []): ClientHealth => {
  const c = client.connection;
  if (client.state !== "online") return { tone: "off", causes: [] };
  if (c.kind !== "wifi") return { tone: c.kind === "wired" ? "good" : "off", causes: [] };
  const causes: ClientHealth["causes"] = [];
  const signal = tone.signal(c.signal);
  if (signal === "poor" || signal === "fair") causes.push({ tone: signal, text: `${signal === "poor" ? "Weak" : "Fair"} signal (${c.signal} dBm)` });
  const air = radios.find((r) => r.accessPoint === c.accessPoint && r.band === c.band && r.busy !== undefined)?.busy;
  if (tone.busy(air) === "poor") causes.push({ tone: "fair", text: `Busy channel (${air}% of the air in use)` });
  const heard = client.heardBy.filter((h) => h.signal !== undefined);
  const here = heard.find((h) => h.connected) ?? (c.signal !== undefined ? { accessPoint: c.accessPoint, band: c.band, signal: c.signal } : undefined);
  const best = [...heard].sort((a, b) => b.signal! - a.signal!)[0];
  if (here?.signal !== undefined && best && best.accessPoint !== c.accessPoint && best.signal! - here.signal >= roamGainDb) {
    causes.push({ tone: "fair", text: `${best.accessPoint} hears it ${best.signal! - here.signal} dB better` });
  }
  const faster = heard.find((h) => h.band && h.band !== "2.4 GHz" && h.signal! >= otherBandUsable);
  if (c.band === "2.4 GHz" && faster) causes.push({ tone: "fair", text: `On 2.4 GHz, though ${faster.band} reaches it` });
  return { tone: causes.length ? worst(...causes.map((x) => x.tone)) : signal === "off" ? "good" : signal, causes };
};

/** Each line's share of time up over points ([start, mean, reads]): reads weigh in, and a point not read counts for nothing. */
export const uptimeOf = (points: [number, number, number][]) => {
  const reads = points.reduce((n, p) => n + p[2], 0);
  return reads ? points.reduce((up, p) => up + p[1] * p[2], 0) / reads : undefined;
};

/** An outage strip's cell: what share of it was up, and how it reads; off where nothing was read. */
export const cellTone = (share: number | undefined): Tone => (share === undefined ? "off" : share >= 0.999 ? "good" : share >= 0.5 ? "fair" : "poor");
