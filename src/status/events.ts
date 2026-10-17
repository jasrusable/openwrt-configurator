// What happened, in words: made by the collector from each read and the one
// before (never from the devices' logs, which roll over and word things
// their own way), so every host tells the same events. A read sees only
// every 10 to 60 seconds; what happened in between is caught where a device
// keeps a time for it: an interface's or mwan3's time in its state, a
// device's uptime. Pure: the collector keeps what `observe` makes and hands
// it back with the next read.
import { z } from "zod";
import type { NetworkStatus } from "./network";

export const eventKinds = ["line", "failover", "device", "reboot", "apply", "radio", "mesh", "client", "service", "port"] as const;
export type EventKind = (typeof eventKinds)[number];

/** How it reads: a problem, a warning, back to normal, or just so. */
export const eventSeverities = ["problem", "warning", "ok", "info"] as const;

export const eventSchema = z.object({
  at: z.number(),
  kind: z.enum(eventKinds),
  severity: z.enum(eventSeverities),
  /** What it is about, as "<type>:<id>" ("line:wan", "device:Loft", "client:aa:bb:…"): a page filters by it. */
  subject: z.string(),
  /** Where it happened, when that is one device. */
  device: z.string().optional(),
  text: z.string(),
});
export type NetworkEvent = z.infer<typeof eventSchema>;

/** A line's state as last read, and since when it has been so (ms). */
type LineSeen = { name: string; works: boolean; inUse: boolean; since: number };
type DeviceSeen = {
  reachable: boolean;
  /** Seconds since boot, when reached. */
  uptime?: number;
  /** Reads in a row it did not answer, and when the first of them was. */
  misses: number;
  missedSince?: number;
  /** Said lost: two reads missed. */
  lost: boolean;
  /** Answered at least once since the collector started: only then can it be said to stop. */
  seen: boolean;
  ports: Record<string, { up: boolean; speed?: number }>;
  /** Services the settings need running there that are not. */
  stopped: string[];
};

/** What one read showed, as much as the next needs to tell what changed. */
export type Observed = {
  at: number;
  lines: Record<string, LineSeen>;
  devices: Record<string, DeviceSeen>;
  /** Each access point's SSIDs on the air, when it was reached. */
  onAir: Record<string, string[]>;
  /** Each mesh node's direct links, when it was reached. */
  meshLinks: Record<string, string[]>;
};

/** A device that misses this many reads in a row is said lost: one slow answer is not an outage. */
export const missesForLost = 2;

/** Slack on clocks and read times: a state shorter than the gap by less than this is not called a blip. */
const slackSeconds = 20;

const lineWorks = (c: NetworkStatus["connections"][number]) =>
  c.line ? c.line.state === "online" || c.line.state === "disconnecting" : !!c.up;

/** Seconds a line has been in its state, where the router keeps a time for it. */
const lineSeconds = (c: NetworkStatus["connections"][number]) => c.line?.since ?? (c.up ? c.uptime : undefined);

/** What this read shows, carried on from the last where it says nothing new. */
export const observe = (status: NetworkStatus, at: number, previous?: Observed): Observed => {
  const routerRead = status.internet !== undefined;
  const lines = routerRead
    ? Object.fromEntries(
        status.connections.map((c) => {
          const works = lineWorks(c);
          const was = previous?.lines[c.id];
          const seconds = lineSeconds(c);
          const since =
            seconds !== undefined ? at - seconds * 1000 : was && was.works === works ? was.since : at;
          return [c.id, { name: c.name || c.id, works, inUse: !!c.inUse, since }];
        })
      )
    : // The router not read: nothing is known of the lines; what was is kept.
      (previous?.lines ?? {});
  const devices = Object.fromEntries(
    (status.deviceViews ?? []).map((d) => {
      const was = previous?.devices[d.name];
      const misses = d.reachable ? 0 : (was?.misses ?? 0) + 1;
      return [
        d.name,
        {
          reachable: d.reachable,
          ...(d.uptime !== undefined ? { uptime: d.uptime } : {}),
          misses,
          ...(misses > 0 ? { missedSince: was?.missedSince ?? at } : {}),
          lost: misses >= missesForLost,
          seen: d.reachable || !!was?.seen,
          ports: d.reachable
            ? Object.fromEntries(d.ports.map((p) => [p.name, { up: p.up, ...(p.speed ? { speed: p.speed } : {}) }]))
            : (was?.ports ?? {}),
          stopped: d.reachable ? (d.services ?? []).filter((s) => !s.running).map((s) => s.name) : (was?.stopped ?? []),
        },
      ];
    })
  );
  const reached = (name: string) => devices[name]?.reachable;
  const onAir = Object.fromEntries(
    Object.keys(devices).flatMap((name) =>
      reached(name)
        ? [[name, [...new Set((status.radios ?? []).filter((r) => r.accessPoint === name && r.ssid).map((r) => r.ssid!))].sort()]]
        : previous?.onAir[name]
          ? [[name, previous.onAir[name]]]
          : []
    )
  );
  const meshLinks = Object.fromEntries(
    (status.mesh ?? []).map((m) => [m.name, [...new Set(m.links.map((l) => l.to))].sort()])
  );
  return {
    at,
    lines,
    devices,
    onAir,
    meshLinks: { ...Object.fromEntries(Object.entries(previous?.meshLinks ?? {}).filter(([name]) => !reached(name))), ...meshLinks },
  };
};

/** "98 s", "3 min", "2 h 5 min": how long something lasted; seconds while they still say much. */
export const lasted = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 120) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
};

const added = <T>(before: T[], after: T[]) => after.filter((x) => !before.includes(x));

/** Each line's changes: down, back (and after how long), and a drop too short for the reads to see but its time shows. */
const lineEvents = (before: Observed, after: Observed): NetworkEvent[] =>
  Object.entries(after.lines).flatMap(([id, now]): NetworkEvent[] => {
    const was = before.lines[id];
    if (!was) return [];
    const subject = `line:${id}`;
    if (was.works && !now.works) {
      return [{ at: Math.max(now.since, before.at), kind: "line", severity: "problem", subject, text: `${now.name} went down` }];
    }
    if (!was.works && now.works) {
      const at = Math.max(now.since, before.at);
      return [{ at, kind: "line", severity: "ok", subject, text: `${now.name} came back after ${lasted(at - was.since)}` }];
    }
    // Up at both reads, but up for less time than lay between them: it dropped and came back unseen.
    if (was.works && now.works && now.since > before.at + slackSeconds * 1000) {
      return [{ at: now.since, kind: "line", severity: "warning", subject, text: `${now.name} dropped and came back` }];
    }
    return [];
  });

/** With several lines, which carries the traffic: moved off the main line is a warning, back onto it all clear. */
const failoverEvents = (before: Observed, after: Observed): NetworkEvent[] => {
  const ids = Object.keys(after.lines);
  if (ids.length < 2) return [];
  const carrying = (o: Observed) => ids.filter((id) => o.lines[id]?.inUse);
  const [was, now] = [carrying(before), carrying(after)];
  const moved = added(was, now);
  if (!moved.length || !was.length) return [];
  const main = ids[0];
  const names = moved.map((id) => after.lines[id].name).join(" and ");
  return [
    {
      at: after.at,
      kind: "failover",
      severity: moved.includes(main) ? "ok" : "warning",
      subject: `line:${moved[0]}`,
      text: moved.includes(main) ? `Traffic is back on ${names}` : `Traffic moved to ${names}`,
    },
  ];
};

const deviceEvents = (before: Observed, after: Observed): NetworkEvent[] =>
  Object.entries(after.devices).flatMap(([name, now]): NetworkEvent[] => {
    const was = before.devices[name];
    if (!was) return [];
    const subject = `device:${name}`;
    const out: NetworkEvent[] = [];
    if (!was.lost && now.lost && was.seen) {
      out.push({ at: now.missedSince ?? after.at, kind: "device", severity: "problem", subject, device: name, text: `${name} stopped answering` });
    }
    if (now.reachable && (was.lost || !was.reachable)) {
      // Back: when it was last heard of, and whether it restarted meanwhile (its uptime is shorter than the silence).
      const quietFrom = was.missedSince ?? before.at;
      if (was.lost && was.seen) out.push({ at: after.at, kind: "device", severity: "ok", subject, device: name, text: `${name} answers again after ${lasted(after.at - quietFrom)}` });
      if (now.uptime !== undefined && now.uptime * 1000 < after.at - quietFrom + slackSeconds * 1000) {
        out.push({ at: after.at - now.uptime * 1000, kind: "reboot", severity: "warning", subject, device: name, text: `${name} restarted` });
      }
    } else if (now.reachable && was.reachable && was.uptime !== undefined && now.uptime !== undefined) {
      // Answered both times, yet its clock started again in between.
      if (now.uptime + slackSeconds < was.uptime + (after.at - before.at) / 1000 && now.uptime * 1000 < after.at - before.at + slackSeconds * 1000) {
        out.push({ at: after.at - now.uptime * 1000, kind: "reboot", severity: "warning", subject, device: name, text: `${name} restarted` });
      }
    }
    if (now.reachable && was.reachable) {
      for (const service of added(was.stopped, now.stopped)) {
        out.push({ at: after.at, kind: "service", severity: "warning", subject: `service:${name}:${service}`, device: name, text: `${service} stopped on ${name}` });
      }
      for (const service of added(now.stopped, was.stopped)) {
        out.push({ at: after.at, kind: "service", severity: "ok", subject: `service:${name}:${service}`, device: name, text: `${service} is running again on ${name}` });
      }
      for (const [port, link] of Object.entries(now.ports)) {
        const old = was.ports[port];
        if (!old) continue;
        const portSubject = `port:${name}:${port}`;
        if (!old.up && link.up) {
          out.push({ at: after.at, kind: "port", severity: "info", subject: portSubject, device: name, text: `${port} on ${name} connected${link.speed ? ` at ${speedWords(link.speed)}` : ""}` });
        } else if (old.up && !link.up) {
          out.push({ at: after.at, kind: "port", severity: "info", subject: portSubject, device: name, text: `${port} on ${name} disconnected` });
        } else if (old.up && link.up && old.speed && link.speed && link.speed < old.speed) {
          // Slower than it was: a cable or a socket going bad, usually.
          out.push({ at: after.at, kind: "port", severity: "warning", subject: portSubject, device: name, text: `${port} on ${name} slowed to ${speedWords(link.speed)} (was ${speedWords(old.speed)})` });
        }
      }
    }
    return out;
  });

const speedWords = (mbps: number) => (mbps >= 1000 ? `${mbps / 1000} Gbit/s` : `${mbps} Mbit/s`);

/** SSIDs going off the air and coming back, per access point, where it was reached both times. */
const radioEvents = (before: Observed, after: Observed): NetworkEvent[] =>
  Object.entries(after.onAir).flatMap(([ap, ssids]) => {
    const was = before.onAir[ap];
    if (!was || !after.devices[ap]?.reachable || !before.devices[ap]?.reachable) return [];
    return [
      ...added(ssids, was).map((ssid): NetworkEvent => ({ at: after.at, kind: "radio", severity: "warning", subject: `radio:${ap}`, device: ap, text: `“${ssid}” went off the air at ${ap}` })),
      ...added(was, ssids).map((ssid): NetworkEvent => ({ at: after.at, kind: "radio", severity: "ok", subject: `radio:${ap}`, device: ap, text: `“${ssid}” is on the air again at ${ap}` })),
    ];
  });

const meshEvents = (before: Observed, after: Observed): NetworkEvent[] =>
  Object.entries(after.meshLinks).flatMap(([node, links]) => {
    const was = before.meshLinks[node];
    if (!was || !after.devices[node]?.reachable) return [];
    return [
      ...added(links, was).map((to): NetworkEvent => ({ at: after.at, kind: "mesh", severity: "warning", subject: `mesh:${node}`, device: node, text: `${node} lost its mesh link to ${to}` })),
      ...added(was, links).map((to): NetworkEvent => ({ at: after.at, kind: "mesh", severity: "ok", subject: `mesh:${node}`, device: node, text: `${node} linked to ${to} over the mesh` })),
    ];
  });

/** What changed between two reads, oldest first. Nothing before there is a read to compare with. */
export const eventsBetween = (before: Observed | undefined, after: Observed): NetworkEvent[] =>
  before
    ? [
        ...lineEvents(before, after),
        ...failoverEvents(before, after),
        ...deviceEvents(before, after),
        ...radioEvents(before, after),
        ...meshEvents(before, after),
      ].sort((a, b) => a.at - b.at)
    : [];

/** How long events are kept, and how many at most. */
export const eventsKeptMs = 30 * 24 * 3600_000;
export const eventsKeptMax = 5000;

/** Kept events with fresh ones, newest first: the same event told twice kept once, the old and the surplus dropped. */
export const keepEvents = (kept: NetworkEvent[], fresh: NetworkEvent[], now: number): NetworkEvent[] =>
  [...fresh, ...kept]
    .filter((e, i, all) => i === all.findIndex((o) => o.subject === e.subject && o.text === e.text && Math.abs(o.at - e.at) < 2000))
    .filter((e) => e.at > now - eventsKeptMs)
    .sort((a, b) => b.at - a.at)
    .slice(0, eventsKeptMax);
