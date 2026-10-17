// Where each client went: joined, left, roamed to another access point,
// moved to another band. Too many for the network's events (a home's phones
// roam and sleep all day), so each client keeps its own latest few, shown on
// its page and marked on its signal chart. A client is gone only once two
// reads in a row miss it: a phone asleep through one read (they drop off for
// seconds) is not a leave and a join. Pure: the collector keeps it.
import { z } from "zod";
import type { ClientView } from "./views";

export const clientMoveSchema = z.object({
  at: z.number(),
  kind: z.enum(["joined", "left", "roamed", "band"]),
  text: z.string(),
  accessPoint: z.string().optional(),
});
export type ClientMove = z.infer<typeof clientMoveSchema>;

/** Where a client was at the last read, and the reads that have missed it since. */
export const placeSchema = z.object({
  wired: z.boolean().optional(),
  accessPoint: z.string().optional(),
  band: z.string().optional(),
  missed: z.number().optional(),
  missedSince: z.number().optional(),
});
type Place = z.infer<typeof placeSchema>;

export const movesSchema = z.object({
  places: z.record(z.string(), placeSchema),
  byClient: z.record(z.string(), z.array(clientMoveSchema)),
});
export type Moves = z.infer<typeof movesSchema>;

/** Each client keeps this many, for this long. */
export const movesKept = 30;
export const movesForMs = 7 * 24 * 3600_000;
/** Missed by this many reads in a row: gone. */
const goneAfterMisses = 2;

const placeOf = (c: ClientView): Place =>
  c.connection.kind === "wifi"
    ? { accessPoint: c.connection.accessPoint, ...(c.connection.band ? { band: c.connection.band } : {}) }
    : { wired: true };

const where = (p: Place) => (p.wired ? "by cable" : [p.accessPoint && `on ${p.accessPoint}`, p.band].filter(Boolean).join(" · "));

/** What one client did between two reads, if anything. */
const moveOf = (was: Place | undefined, now: Place | undefined, at: number): ClientMove | undefined => {
  if (!was && now) return { at, kind: "joined", text: `Joined ${where(now)}`, ...(now.accessPoint ? { accessPoint: now.accessPoint } : {}) };
  if (!was || !now || was.wired || now.wired) return undefined;
  if (was.accessPoint !== now.accessPoint) {
    return { at, kind: "roamed", text: `Roamed from ${was.accessPoint} to ${now.accessPoint}${now.band ? ` · ${now.band}` : ""}`, ...(now.accessPoint ? { accessPoint: now.accessPoint } : {}) };
  }
  if (was.band && now.band && was.band !== now.band) return { at, kind: "band", text: `Moved to ${now.band} on ${now.accessPoint}`, ...(now.accessPoint ? { accessPoint: now.accessPoint } : {}) };
  return undefined;
};

/**
 * The moves after a read. With nothing kept before (the collector has just
 * started) everyone online is placed and nothing is told: they were already
 * here. Only clients `remembered` keeps (the registry's) keep their moves.
 */
export const updateMoves = ({
  moves,
  clients,
  at,
  remembered = () => true,
}: {
  moves: Moves | undefined;
  clients: ClientView[];
  at: number;
  remembered?: (mac: string) => boolean;
}): Moves => {
  const online = new Map(clients.filter((c) => c.state === "online").map((c) => [c.mac, placeOf(c)]));
  if (!moves) return { places: Object.fromEntries(online), byClient: {} };
  const macs = new Set([...Object.keys(moves.places), ...online.keys()]);
  const stepped = [...macs].map((mac) => {
    const was = moves.places[mac];
    const now = online.get(mac);
    if (now) return { mac, place: now, move: moveOf(was, now, at) };
    const missed = (was?.missed ?? 0) + 1;
    return missed >= goneAfterMisses
      ? { mac, move: { at: was?.missedSince ?? at, kind: "left" as const, text: `Left${was && !was.wired && was.accessPoint ? ` ${was.accessPoint}` : ""}`, ...(was?.accessPoint ? { accessPoint: was.accessPoint } : {}) } }
      : { mac, place: { ...was, missed, missedSince: was?.missedSince ?? at } };
  });
  const byClient = stepped.reduce<Moves["byClient"]>(
    (all, { mac, move }) => (move ? { ...all, [mac]: [move, ...(all[mac] ?? [])] } : all),
    moves.byClient
  );
  return {
    places: Object.fromEntries(stepped.flatMap(({ mac, place }) => (place ? [[mac, place]] : []))),
    byClient: Object.fromEntries(
      Object.entries(byClient)
        .filter(([mac]) => remembered(mac))
        .map(([mac, list]) => [mac, list.filter((m) => at - m.at < movesForMs).slice(0, movesKept)] as const)
        .filter(([, list]) => list.length > 0)
    ),
  };
};
