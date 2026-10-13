// The internet connections, as the rest of the intent sees them: the first
// is the main one, whose IPv6 the networks get (two providers' prefixes at
// once would leave clients using a dead one when a line fails).
import type { Intent } from "./schema";

export type Connection = Intent["internet"]["connections"][number];

export const primaryConnection = (intent: Pick<Intent, "internet">) => intent.internet.connections[0];

/** Whether the networks can have IPv6: the main connection brings it. */
export const internetIpv6 = (intent: Pick<Intent, "internet">) => !!primaryConnection(intent)?.ipv6;

/**
 * Whether a network has IPv6 as compiled: the internet brings it, the network
 * wants it, and it goes out the main line (IPv6 has only the main's, so a
 * network kept to another line or a provider's tunnel has none).
 */
export const networkHasIpv6 = (
  intent: Pick<Intent, "internet">,
  network: Pick<Intent["networks"][number], "ipv6" | "line">
) => internetIpv6(intent) && !!network.ipv6 && !(network.line && network.line.connection !== primaryConnection(intent).id);

/** Its IPv6 interface's name: wan6 for wan, wanb6 for wanb. */
export const ipv6Interface = (connection: Pick<Connection, "id">) => `${connection.id}6`;

/** Whether more than one line is used together (mwan3). */
export const multiWan = (intent: Pick<Intent, "internet">) => intent.internet.connections.length > 1;

/**
 * Which connection already uses `port` (unset: the router's WAN port), other
 * than connection `index`: a port carries one line.
 */
export const portTakenBy = (intent: Pick<Intent, "internet">, index: number, port: string | undefined) =>
  intent.internet.connections.find((c, j) => j !== index && c.port === port);

/**
 * How mwan3 tells a line works: it pings these out of each line every
 * `intervalS` seconds, `count` at a time; `missesDown` failed checks in a row
 * mark the line down (`reliability` of the addresses answering is up), so a
 * failed line is left within about interval × misses seconds. A metered line
 * is checked sparingly (`monthlyMegabytes` says what each costs).
 */
export const lineCheck = { ips: ["1.1.1.1", "9.9.9.9", "8.8.8.8"], reliability: 2, intervalS: 5, timeoutS: 2, missesDown: 3 } as const;
export const meteredCheck = { ips: ["1.1.1.1"], reliability: 1, intervalS: 30, timeoutS: 2, missesDown: 3 } as const;
export const checkOf = (connection: Pick<Connection, "metered">) => (connection.metered ? meteredCheck : lineCheck);

/**
 * How long a dead line takes to be marked down: mwan3track pings each
 * address in turn, each waiting out its timeout, then sleeps the interval;
 * that many rounds in a row (checked against mwan3track's source).
 */
export const secondsToDown = (check: { ips: readonly string[]; intervalS: number; timeoutS: number; missesDown: number }) =>
  check.missesDown * (check.ips.length * check.timeoutS + check.intervalS);

/** Failover's order: the list's, every metered line after the others (a last resort, as when sharing). */
export const failoverOrder = <C extends Pick<Connection, "metered">>(connections: C[]) => [
  ...connections.filter((c) => !c.metered),
  ...connections.filter((c) => c.metered),
];

/**
 * When a slow line counts as down: worse than `failMs` or `failLossPct` over
 * a check; back up once better than `recoverMs` and `recoverLossPct`. Each
 * check then sends `count` pings to each address, to measure loss.
 */
export const slowLine = { failMs: 500, failLossPct: 20, recoverMs: 250, recoverLossPct: 5, count: 5 } as const;

/** How long a device keeps to the line it was given, sharing per device. */
export const stickySeconds = 600;

/** What a check costs a month on its line: an ICMP echo and its reply, 84 bytes each way, per ping. */
export const monthlyMegabytes = (check: { ips: readonly string[]; intervalS: number }, count = 1) =>
  Math.round((check.ips.length * count * 168 * (30 * 86400)) / check.intervalS / 1e6);

/**
 * The connections with `index` first, the main one. The networks' IPv6
 * comes from the main one alone, so its IPv6 settings move with the role:
 * promoting a backup (made without IPv6) must not turn IPv6 off everywhere.
 */
export const withMain = (connections: Connection[], index: number): Connection[] => {
  const [main] = connections;
  const promoted = connections[index];
  if (!main || !promoted || index === 0) return connections;
  return [
    { ...promoted, ipv6: main.ipv6, ipv6_prefix: main.ipv6_prefix },
    ...connections.filter((_, i) => i !== index),
  ];
};

/** The connections without `index`; the main one's IPv6 settings pass to the next when it goes. */
export const withoutConnection = (connections: Connection[], index: number): Connection[] =>
  // withMain puts the second first and the main second: that one goes.
  index === 0 ? withMain(connections, 1).filter((_, i) => i !== 1) : connections.filter((_, i) => i !== index);
