// What one device is doing now, read in one round trip: the same `ubus call`s
// LuCI's status pages make, run over SSH for now. Their JSON is exactly what
// ubus over HTTPS will return once the read-only monitor login exists, so
// these parsers stay and only the transport changes (CLAUDE.md, "Reading
// devices"). Parsing is defensive: a field a release lacks is left out, never
// an error. Nothing here prints a config value.
import { Probe, runProbes } from "../deviceProbes";
import { parseJson } from "../parseJson";
import { Session } from "../platform";

export type InterfaceStatus = {
  /** The UCI interface: lan, guest, wan, wan6... */
  id: string;
  up: boolean;
  /** Seconds up. */
  uptime?: number;
  /** The Linux device it runs on, e.g. br-lan.20 or eth1. */
  device?: string;
  ipv4: string[];
  ipv6: string[];
};

export type WifiClient = { mac: string; signal?: number; rxBytes?: number; txBytes?: number };

export type WifiInterface = {
  /** hostapd's interface, e.g. phy1-ap0. */
  ifname: string;
  ssid?: string;
  /** MHz. */
  freq?: number;
  channel?: number;
  clients: WifiClient[];
};

export type Lease = { mac: string; address: string; name?: string; /** s since the epoch */ expires: number };

export type DeviceStatus = {
  hostname: string;
  readAt: number;
  /** Seconds since boot. */
  uptime: number;
  /** 1, 5 and 15 minute load averages. */
  load: [number, number, number];
  memory: { total: number; available: number };
  interfaces: InterfaceStatus[];
  wifi: WifiInterface[];
  leases: Lease[];
  /** mwan3's view of each line, where it runs (a router with several connections). */
  lines: LineStatus[];
  /** Its mesh neighbours, where batman-adv runs: each directly linked node and the link's quality. */
  mesh: MeshNeighbour[];
  /** Its WireGuard peers: when each last completed a handshake. */
  wireguard: WireguardPeer[];
};

export type WireguardPeer = {
  /** The WireGuard interface: vpn, sites, tun1. */
  iface: string;
  publicKey: string;
  /** Seconds since its last handshake; undefined if it has never made one. */
  since?: number;
};

export type MeshNeighbour = {
  /** The node, by its batman address (its first interface's MAC). */
  originator: string;
  /** The next hop to it: the MAC of the neighbour's interface on the link. */
  mac: string;
  /** BATMAN_V's estimate of the route's throughput, in Mbit/s. */
  throughput: number;
  /** Seconds since it was last heard. */
  lastSeen: number;
};

export type LineStatus = {
  /** The connection's interface: wan, wanb. */
  id: string;
  /** online, offline, connecting (coming back), disconnecting (failing), or mwan3's other words. */
  state: string;
  /** Seconds in that state: online for, or offline for. */
  since: number;
};

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const str = (value: unknown) => (typeof value === "string" ? value : undefined);
const arr = (value: unknown) => (Array.isArray(value) ? value : []);
const json = (stdout: string, what: string) => (stdout.trim() ? parseJson(stdout, what) : undefined);

/** `ubus call system info`: uptime, load (×65536 there), memory. */
export const parseSystemInfo = (info: unknown) => {
  const o = obj(info);
  const load = arr(o.load).map((l) => (num(l) ?? 0) / 65536);
  const memory = obj(o.memory);
  return {
    uptime: num(o.uptime) ?? 0,
    load: [load[0] ?? 0, load[1] ?? 0, load[2] ?? 0] as [number, number, number],
    memory: {
      total: num(memory.total) ?? 0,
      available: num(memory.available) ?? num(memory.free) ?? 0,
    },
  };
};

/** `ubus call network.interface dump`: each interface's state and addresses; loopback left out. */
export const parseInterfaces = (dump: unknown): InterfaceStatus[] =>
  arr(obj(dump).interface)
    .map(obj)
    .filter((i) => str(i.interface) && i.interface !== "loopback")
    .map((i) => ({
      id: str(i.interface)!,
      up: i.up === true,
      ...(num(i.uptime) !== undefined ? { uptime: num(i.uptime) } : {}),
      ...(str(i.l3_device) ?? str(i.device) ? { device: str(i.l3_device) ?? str(i.device) } : {}),
      ipv4: arr(i["ipv4-address"]).map(obj).flatMap((a) => (str(a.address) ? [`${a.address}/${a.mask}`] : [])),
      ipv6: [
        ...arr(i["ipv6-address"]).map(obj),
        ...arr(i["ipv6-prefix-assignment"]).map((a) => obj(obj(a)["local-address"])),
      ].flatMap((a) => (str(a.address) ? [`${a.address}/${a.mask}`] : [])),
    }));

/** The Wi-Fi probe's array: each hostapd interface's get_status and get_clients. */
export const parseWifi = (list: unknown): WifiInterface[] =>
  arr(list)
    .map(obj)
    .map((entry) => {
      const status = obj(entry.status);
      const clients = obj(obj(entry.clients).clients);
      return {
        ifname: (str(entry.object) ?? "").replace(/^hostapd\./, ""),
        ...(str(status.ssid) ? { ssid: str(status.ssid) } : {}),
        ...(num(status.freq) !== undefined ? { freq: num(status.freq) } : {}),
        ...(num(status.channel) !== undefined ? { channel: num(status.channel) } : {}),
        clients: Object.entries(clients).map(([mac, client]) => {
          const c = obj(client);
          const bytes = obj(c.bytes);
          return {
            mac: mac.toLowerCase(),
            ...(num(c.signal) !== undefined ? { signal: num(c.signal) } : {}),
            ...(num(bytes.rx) !== undefined ? { rxBytes: num(bytes.rx) } : {}),
            ...(num(bytes.tx) !== undefined ? { txBytes: num(bytes.tx) } : {}),
          };
        }),
      };
    });

/** dnsmasq's /tmp/dhcp.leases: "expires mac address name clientid" per line; "*" is no name. */
export const parseLeases = (text: string): Lease[] =>
  text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((f) => f.length >= 3 && /^\d+$/.test(f[0]))
    .map(([expires, mac, address, name]) => ({
      mac: mac.toLowerCase(),
      address,
      ...(name && name !== "*" ? { name } : {}),
      expires: Number(expires),
    }));

const systemInfo: Probe<unknown> = {
  command: "ubus call system info",
  parse: ({ stdout }) => json(stdout, "system info"),
};

const interfaces: Probe<unknown> = {
  command: "ubus call network.interface dump",
  parse: ({ stdout }) => json(stdout, "network.interface dump"),
};

// One JSON array, built by the shell, so no output needs splitting: an
// access point's hostapd interfaces with their status and clients; none on a
// device without Wi-Fi. A call that fails gives null.
const wifi: Probe<unknown> = {
  command: [
    "printf '['; sep=''",
    "for o in $(ubus list 'hostapd.*' 2>/dev/null); do",
    `  printf '%s{"object":"%s","status":' "$sep" "$o"; ubus call "$o" get_status 2>/dev/null || printf 'null'`,
    `  printf ',"clients":'; ubus call "$o" get_clients 2>/dev/null || printf 'null'`,
    "  printf '}'; sep=','",
    "done; printf ']'",
  ].join("\n"),
  parse: ({ stdout }) => json(stdout, "hostapd"),
};

/** mwan3's lines, without what it pings (no need, and kept short). Nothing where mwan3 is not running. */
const mwan3: Probe<unknown> = {
  command: "ubus call mwan3 status 2>/dev/null || echo '{}'",
  parse: ({ stdout }) => json(stdout || "{}", "mwan3 status"),
};

/** `ubus call mwan3 status`, as each line's state and for how long. */
export const parseLines = (status: unknown): LineStatus[] =>
  Object.entries(obj(obj(status).interfaces)).map(([id, value]) => {
    const line = obj(value);
    const state = typeof line.status === "string" ? line.status : "unknown";
    const online = state === "online" || state === "disconnecting";
    const since = Number(online ? line.online : line.offline);
    return { id, state, since: Number.isFinite(since) ? since : 0 };
  });

/** batman-adv's originator table, without its header; nothing where batman does not run. */
const originators: Probe<string> = {
  command: "batctl meshif bat0 originators -H 2>/dev/null || true",
  parse: ({ stdout }) => stdout,
};

/**
 * The best route (marked *) to each originator in `batctl o -H`, through
 * which neighbour. A line reads
 * " * 02:aa:bb:cc:dd:01    0.420s   ( 54.0) 02:aa:bb:cc:dd:01 [     mesh0]";
 * the throughput in Mbit/s, as BATMAN_V (the compiler's) prints it.
 */
export const parseRoutes = (text: string) =>
  text.split("\n").flatMap((line) => {
    const m = /^\s*\*\s*([0-9a-f:]{17})\s+([\d.]+)s\s+\(\s*([\d.]+)\)\s+([0-9a-f:]{17})/i.exec(line);
    return m
      ? [
          {
            originator: m[1].toLowerCase(),
            nexthop: m[4].toLowerCase(),
            throughput: Number(m[3]),
            lastSeen: Number(m[2]),
          },
        ]
      : [];
  });

/**
 * Every node's best route. Which are direct neighbours is decided with the
 * devices' MACs (networkStatus): a node with several interfaces (the mesh,
 * a cable) is known by its first, while its next hop is the one on the link.
 */
export const parseOriginators = (text: string): MeshNeighbour[] =>
  parseRoutes(text).map((r) => ({ originator: r.originator, mac: r.nexthop, throughput: r.throughput, lastSeen: r.lastSeen }));

/**
 * WireGuard's handshakes, after the device's clock: "<now>" then lines of
 * "<interface> <peer key> <unix time>". Never `wg show dump`, which prints
 * each interface's private key.
 */
const handshakes: Probe<string> = {
  command: "date +%s; wg show all latest-handshakes 2>/dev/null || true",
  parse: ({ stdout }) => stdout,
};

export const parseHandshakes = (text: string): WireguardPeer[] => {
  const [first = "", ...lines] = text.split("\n");
  const now = Number(first.trim());
  return lines.flatMap((line) => {
    const [iface, publicKey, time] = line.trim().split(/\s+/);
    if (!iface || !publicKey || time === undefined) return [];
    const at = Number(time);
    return [{ iface, publicKey, ...(at > 0 && Number.isFinite(now) ? { since: Math.max(0, now - at) } : {}) }];
  });
};

const leases: Probe<string> = {
  command: "cat /tmp/dhcp.leases 2>/dev/null || true",
  parse: ({ stdout }) => stdout,
};

/** Read what `hostname` is doing, over an open session. */
export const readDeviceStatus = async (
  hostname: string,
  session: Session,
  now: () => number
): Promise<DeviceStatus> => {
  const read = await runProbes(session, { systemInfo, interfaces, wifi, leases, mwan3, originators, handshakes });
  return {
    hostname,
    readAt: now(),
    ...parseSystemInfo(read.systemInfo),
    interfaces: parseInterfaces(read.interfaces),
    wifi: parseWifi(read.wifi),
    leases: parseLeases(read.leases),
    lines: parseLines(read.mwan3),
    mesh: parseOriginators(read.originators),
    wireguard: parseHandshakes(read.handshakes),
  };
};
