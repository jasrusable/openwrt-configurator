// The internet lines, as the rest of the intent sees them: the first is the
// main one, whose IPv6 the networks get (two providers' prefixes at once
// would leave clients using a dead one when a line fails).
import type { Intent } from "./schema";

export type Connection = Intent["internet"]["lines"][number];

export const primaryConnection = (intent: Pick<Intent, "internet">) => intent.internet.lines[0];

/** Whether the networks can have IPv6: the main connection brings it. */
export const internetIpv6 = (intent: Pick<Intent, "internet">) => !!primaryConnection(intent)?.ipv6.enabled;

/**
 * Whether a network has IPv6 as compiled: the internet brings it, the network
 * wants it, and it goes out the main line (IPv6 has only the main's, so a
 * network kept to another line or a provider's tunnel has none).
 */
export const networkHasIpv6 = (
  intent: Pick<Intent, "internet">,
  network: Pick<Intent["networks"][number], "ipv6" | "access">
) => internetIpv6(intent) && !!network.ipv6 && !(network.access.via && network.access.via !== primaryConnection(intent).id);

/** Its IPv6 interface's name: wan6 for wan, wanb6 for wanb. */
export const ipv6Interface = (connection: Pick<Connection, "id">) => `${connection.id}6`;

/** Whether more than one line is used together (mwan3). */
export const multiWan = (intent: Pick<Intent, "internet">) => intent.internet.lines.length > 1;

/**
 * Whether two lines would be one device: the same port (unset: the router's
 * WAN port) and VLAN. A port carries one line per VLAN, one of them untagged.
 */
export const samePort = (a: Pick<Connection, "port" | "vlan">, b: Pick<Connection, "port" | "vlan">) =>
  a.port === b.port && a.vlan === b.vlan;

/** Which other line already uses `port` as line `index` would (with its VLAN). */
export const portTakenBy = (intent: Pick<Intent, "internet">, index: number, port: string | undefined) => {
  const line = { port, vlan: intent.internet.lines[index]?.vlan };
  return intent.internet.lines.find((c, j) => j !== index && samePort(c, line));
};

/**
 * How mwan3 tells a line works: it pings these out of each line every
 * `intervalS` seconds, `count` at a time; `missesDown` failed checks in a row
 * mark the line down (`reliability` of the addresses answering is up), so a
 * failed line is left within about interval × misses seconds. A metered line
 * is checked sparingly (`monthlyMegabytes` says what each costs).
 */
export const lineCheck = { ips: ["1.1.1.1", "9.9.9.9", "8.8.8.8"], reliability: 2, intervalS: 5, timeoutS: 2, missesDown: 3 } as const;
export const meteredCheck = { ips: ["1.1.1.1"], reliability: 1, intervalS: 30, timeoutS: 2, missesDown: 3 } as const;
export const checkOf = (connection: Pick<Connection, "failover">) => (connection.failover.metered ? meteredCheck : lineCheck);

/**
 * How long a dead line takes to be marked down: mwan3track pings each
 * address in turn, each waiting out its timeout, then sleeps the interval;
 * that many rounds in a row (checked against mwan3track's source).
 */
export const secondsToDown = (check: { ips: readonly string[]; intervalS: number; timeoutS: number; missesDown: number }) =>
  check.missesDown * (check.ips.length * check.timeoutS + check.intervalS);

/** Failover's order: the list's, every metered line after the others (a last resort, as when sharing). */
export const failoverOrder = <C extends Pick<Connection, "failover">>(connections: C[]) => [
  ...connections.filter((c) => !c.failover.metered),
  ...connections.filter((c) => c.failover.metered),
];

/**
 * What line `index` is for, in people's words, as the compiler uses it: the
 * main line, a backup in failover's order, a last resort (metered), or its
 * share when the lines share traffic.
 */
export const lineRole = (intent: Pick<Intent, "internet">, index: number) => {
  const lines = intent.internet.lines;
  const line = lines[index];
  const ipv6 = index === 0 ? "; your networks get IPv6 from it" : "";
  if (!line || lines.length < 2) return { label: "Main", description: "The only connection." };
  if (line.failover.metered) return { label: "Last resort", description: `Used only when every other line is down${ipv6}.` };
  if (intent.internet.use_lines.mode === "balance") {
    return { label: `Share ${line.failover.weight}`, description: `Shares traffic with the others, by weight${ipv6}.` };
  }
  const backups = failoverOrder(lines).filter((c) => c !== lines[0] && !c.failover.metered);
  if (index === 0) return { label: "Main", description: `Used first${ipv6}.` };
  const n = backups.indexOf(line) + 1;
  return {
    label: backups.length > 1 ? `Backup ${n}` : "Backup",
    description: n > 1 ? "Used when the lines before it are down." : "Used when the main line is down.",
  };
};

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
 * The lines with `index` first, the main one. The networks' IPv6
 * comes from the main one alone, so its IPv6 settings move with the role:
 * promoting a backup (made without IPv6) must not turn IPv6 off everywhere.
 */
export const withMain = (connections: Connection[], index: number): Connection[] => {
  const [main] = connections;
  const promoted = connections[index];
  if (!main || !promoted || index === 0) return connections;
  return [
    { ...promoted, ipv6: main.ipv6 },
    ...connections.filter((_, i) => i !== index),
  ];
};

/** The lines without `index`; the main one's IPv6 settings pass to the next when it goes. */
export const withoutConnection = (connections: Connection[], index: number): Connection[] =>
  // withMain puts the second first and the main second: that one goes.
  index === 0 ? withMain(connections, 1).filter((_, i) => i !== 1) : connections.filter((_, i) => i !== index);

/** How many networks' /64s a delegated IPv6 prefix of this length holds. */
export const roomIn = (prefix: string) => 2 ** (64 - Number(prefix));
