// Every client the network has seen, remembered between reads: when it was
// first and last online, what it was last called and where, so a page can
// say "new today", name a device that is away, and list who was here. A
// client you have not named (a fixed address) is forgotten after 30 days
// unseen; phones that make up a MAC per network ("private address") would
// otherwise pile up, and are never counted as new. Pure: the collector keeps
// it, beside the history, and flushes it to flash on a router.
import { z } from "zod";
import type { ClientView } from "./views";

export const knownClientSchema = z.object({
  mac: z.string(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  name: z.string().optional(),
  kind: z.string().optional(),
  model: z.string().optional(),
  ipv4: z.string().optional(),
  network: z.string().optional(),
  connection: z.enum(["wifi", "wired"]).optional(),
  accessPoint: z.string().optional(),
  band: z.string().optional(),
});
export type KnownClient = z.infer<typeof knownClientSchema>;

export const registrySchema = z.object({
  /** When remembering began: everyone online then was already here, not new. */
  since: z.number(),
  clients: z.record(z.string(), knownClientSchema),
});
export type Registry = z.infer<typeof registrySchema>;

/** Forgotten after this long unseen, unless you named it. */
export const forgetAfterMs = 30 * 24 * 3600_000;
/** At most this many remembered: the longest unseen go first. */
export const rememberedMax = 500;
/** First seen within this long: new. */
export const newForMs = 24 * 3600_000;
/** Seen within this long of remembering beginning: it was already here. */
const settlingMs = 10 * 60_000;

/**
 * A MAC its device made up (the locally administered bit set): iOS, Android
 * and Windows make one per network, so it says nothing of who is new.
 */
export const isPrivateMac = (mac: string) => (parseInt(mac.slice(0, 2), 16) & 2) === 2;

const remembered = (c: ClientView, at: number, was?: KnownClient): KnownClient => ({
  ...was,
  mac: c.mac,
  firstSeen: was?.firstSeen ?? at,
  lastSeen: at,
  ...(c.name ? { name: c.name } : {}),
  ...(c.kind ? { kind: c.kind } : {}),
  ...(c.model ? { model: c.model } : {}),
  ...(c.ipv4 ? { ipv4: c.ipv4 } : {}),
  ...(c.network ? { network: c.network } : {}),
  ...(c.connection.kind === "wifi"
    ? { connection: "wifi" as const, accessPoint: c.connection.accessPoint, ...(c.connection.band ? { band: c.connection.band } : {}) }
    : c.connection.kind === "wired"
      ? { connection: "wired" as const }
      : {}),
});

/** Whether a client remembered counts as new now. */
export const isNew = (registry: Registry, known: KnownClient, now: number) =>
  !isPrivateMac(known.mac) && known.firstSeen > registry.since + settlingMs && now - known.firstSeen < newForMs;

/**
 * The registry after a read: everyone online seen now, the long unseen
 * forgotten (but never one `keep` says you named), and those seen for the
 * first time, who count as new.
 */
export const updateRegistry = ({
  registry,
  clients,
  at,
  keep = () => false,
}: {
  registry: Registry | undefined;
  clients: ClientView[];
  at: number;
  keep?: (mac: string) => boolean;
}): { registry: Registry; fresh: KnownClient[] } => {
  const base = registry ?? { since: at, clients: {} };
  const online = clients.filter((c) => c.state === "online");
  const seen = Object.fromEntries(online.map((c) => [c.mac, remembered(c, at, base.clients[c.mac])]));
  const all = { ...base.clients, ...seen };
  const kept = Object.values(all)
    .filter((k) => keep(k.mac) || at - k.lastSeen < forgetAfterMs)
    .sort((a, b) => Number(keep(b.mac)) - Number(keep(a.mac)) || b.lastSeen - a.lastSeen)
    .slice(0, rememberedMax);
  const next = { since: base.since, clients: Object.fromEntries(kept.map((k) => [k.mac, k])) };
  const fresh = Object.values(seen).filter((k) => !base.clients[k.mac] && next.clients[k.mac] && isNew(next, k, at));
  return { registry: next, fresh };
};

/**
 * The clients read now, each with when it was first and last seen and
 * whether it is new; then those remembered but not read now (away), so the
 * list holds everyone the network has seen lately.
 */
export const withRegistry = (
  clients: ClientView[],
  registry: Registry | undefined,
  now: number,
  /** A fixed address of yours: said so of a remembered client too. */
  reserved: (mac: string) => boolean = () => false
): ClientView[] => {
  if (!registry) return clients.map((c) => (isPrivateMac(c.mac) ? { ...c, private: true } : c));
  const here = new Set(clients.map((c) => c.mac));
  const marked = (c: ClientView, known: KnownClient | undefined): ClientView => ({
    ...c,
    ...(known ? { firstSeen: known.firstSeen, lastSeen: known.lastSeen } : {}),
    ...(known && isNew(registry, known, now) ? { new: true } : {}),
    ...(isPrivateMac(c.mac) ? { private: true } : {}),
  });
  const away = Object.values(registry.clients)
    .filter((k) => !here.has(k.mac))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(
      (k): ClientView => ({
        mac: k.mac,
        ...(k.name ? { name: k.name } : {}),
        ...(k.kind ? { kind: k.kind as ClientView["kind"] } : {}),
        ...(k.model ? { model: k.model } : {}),
        ...(k.ipv4 ? { ipv4: k.ipv4 } : {}),
        ipv6: [],
        ...(k.network ? { network: k.network } : {}),
        connection: { kind: "unknown" },
        state: "away",
        reserved: reserved(k.mac),
        heardBy: [],
      })
    );
  return [...clients.map((c) => marked(c, registry.clients[c.mac])), ...away.map((c) => marked(c, registry.clients[c.mac]))];
};
