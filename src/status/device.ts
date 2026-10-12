// What one device is doing now, read in one round trip: the same `ubus call`s
// LuCI's status pages make, run over SSH for now. Their JSON is exactly what
// ubus over HTTPS will return once the read-only monitor login exists, so
// these parsers stay and only the transport changes (CLAUDE.md, "Reading
// devices"). Parsing is defensive: a field a release lacks is left out, never
// an error. Nothing here prints a config value.
import { notRunning, Probe, runProbes } from "../deviceProbes";
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

export type WifiClient = {
  mac: string;
  signal?: number;
  rxBytes?: number;
  txBytes?: number;
  /** Seconds since it associated. */
  connected?: number;
};

export type WifiInterface = {
  /** hostapd's interface, e.g. phy1-ap0. */
  ifname: string;
  ssid?: string;
  /** MHz. */
  freq?: number;
  channel?: number;
  /** From iwinfo: the mode and width (HE80), transmit power (dBm), noise floor (dBm). */
  htmode?: string;
  txpower?: number;
  noise?: number;
  clients: WifiClient[];
};

/** A port's link: up, and at what speed (Mbit/s) when it says. */
export type PortLink = { name: string; up: boolean; speed?: number };

/** Router advertisements sent and solicitations heard, per device, since it came up. */
export type Adverts = { device: string; sent: number; solicits: number };

/** The kernel's neighbour table: who answered on which address lately. */
export type NeighbourEntry = { address: string; mac: string; state: string };

/** odhcpd's IPv6 leases: by DUID, the MAC where the DUID holds one. */
export type Ipv6Lease = { duid: string; mac?: string; hostname?: string; addresses: string[] };

/** Read only for the Internet view: how the line is doing from the router. */
export type InternetCheck = {
  /** Average round trip to a public resolver, ms; undefined when none answered. */
  latencyMs?: number;
  /** The address the internet sees (another NAT may sit before the router's WAN). */
  publicIpv4?: string;
  /** The router's own DNS (dnsmasq, and its upstream) answering. */
  dnsOk: boolean;
  /** Smart queueing on each device it shapes: bytes sent and packets it dropped (to keep latency down). */
  queues: { device: string; sentBytes: number; dropped: number }[];
};

/** Read only for the Activity view: a device's own log, the lines worth telling. */
export type LogLine = { at: number; text: string };

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
  /**
   * The largest frame the mesh over cables carries whole here: the smallest
   * MTU of its VLAN and the bridge's ports (a bridge may claim more than its
   * ports take). Undefined where there is none.
   */
  meshWiredMtu?: number;
  /**
   * Over that VLAN, how many nodes answered a small ping and how many a
   * full-size one (all on-link, ff02::1): fewer for the large means a switch
   * between drops the mesh's larger frames, which would lose packets.
   */
  meshWiredPath?: { small: number; large: number };
  /** Its WireGuard peers: when each last completed a handshake. */
  wireguard: WireguardPeer[];
  /** Free and total space where packages and config live (the overlay), KiB. */
  storage?: { availableKb: number; totalKb: number };
  /** The hottest thermal zone, °C, where it has any. */
  temperature?: number;
  /** Each network device's link (Wi-Fi interfaces too; the UI picks the ports). */
  links: PortLink[];
  adverts: Adverts[];
  neighbours: NeighbourEntry[];
  ipv6Leases: Ipv6Lease[];
  /** Of the services the settings say must run, those that are not (or are not installed). */
  notRunning: { name: string; missing: boolean }[];
  internet?: InternetCheck;
  log?: LogLine[];
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
        ...(() => {
          const info = obj(entry.info);
          return {
            ...(str(info.htmode) ? { htmode: str(info.htmode) } : {}),
            ...(num(info.txpower) !== undefined ? { txpower: num(info.txpower) } : {}),
            ...(num(info.noise) !== undefined && num(info.noise) !== 0 ? { noise: num(info.noise) } : {}),
          };
        })(),
        clients: Object.entries(clients).map(([mac, client]) => {
          const c = obj(client);
          const bytes = obj(c.bytes);
          return {
            mac: mac.toLowerCase(),
            ...(num(c.signal) !== undefined ? { signal: num(c.signal) } : {}),
            ...(num(bytes.rx) !== undefined ? { rxBytes: num(bytes.rx) } : {}),
            ...(num(bytes.tx) !== undefined ? { txBytes: num(bytes.tx) } : {}),
            ...(num(c.connected_time) !== undefined ? { connected: num(c.connected_time) } : {}),
          };
        }),
      };
    });

/**
 * dnsmasq's leases, wherever its config keeps them (stock /tmp/dhcp.leases;
 * the compiler's own choice may differ), not a fixed path.
 */
export const leasesCommand =
  'cat "$(uci -q get dhcp.@dnsmasq[0].leasefile || echo /tmp/dhcp.leases)" 2>/dev/null || true';

/** dnsmasq's lease file: "expires mac address name clientid" per line; "*" is no name. */
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
  `  printf ',"info":'; ubus call iwinfo info "{\\"device\\":\\"\${o#hostapd.}\\"}" 2>/dev/null || printf 'null'`,
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

/**
 * See DeviceStatus.meshWiredMtu and meshWiredPath: "<mtu> <small> <large>".
 * The large ping fills the MTU exactly (IPv6 and ICMP take 48 bytes).
 */
const meshWired: Probe<{ mtu: number; small: number; large: number } | undefined> = {
  command: [
    "d=/sys/class/net/br-lan.4000; [ -e $d ] || exit 0",
    "m=$(cat $d/mtu); for i in /sys/class/net/br-lan/brif/*; do n=${i##*/}; [ \"$n\" = bat0 ] && continue; v=$(cat /sys/class/net/$n/mtu); [ \"$v\" -lt \"$m\" ] && m=$v; done",
    'heard() { ping -6 -c 1 -W 1 -I br-lan.4000 "$@" ff02::1 2>/dev/null | grep -o "from [0-9a-f:]*" | sort -u | grep -c .; }',
    'echo "$m $(heard) $(heard -s $(($m - 48)))"',
  ].join("; "),
  parse: ({ stdout }) => {
    const m = /^(\d+) (\d+) (\d+)$/.exec(stdout.trim());
    return m ? { mtu: Number(m[1]), small: Number(m[2]), large: Number(m[3]) } : undefined;
  },
};

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
  command: leasesCommand,
  parse: ({ stdout }) => stdout,
};

const raw = (command: string): Probe<string> => ({ command, parse: ({ stdout }) => stdout });

/** `df -k`'s last line: "<fs> <total> <used> <available> <use%> <mount>". */
export const parseStorage = (text: string) => {
  const f = text.trim().split("\n").pop()?.trim().split(/\s+/) ?? [];
  const [totalKb, availableKb] = [Number(f[1]), Number(f[3])];
  return Number.isFinite(totalKb) && Number.isFinite(availableKb) && totalKb > 0 ? { totalKb, availableKb } : undefined;
};

/** Thermal zones in millidegrees, one per line: the hottest, °C. */
export const parseTemperature = (text: string) => {
  const t = text.split("\n").map(Number).filter((v) => Number.isFinite(v) && v > 0);
  return t.length ? Math.round(Math.max(...t) / 100) / 10 : undefined;
};

/** "<name> <carrier> <speed>" per line; speed -1 or absent when it does not say. */
export const parseLinks = (text: string): PortLink[] =>
  text.split("\n").flatMap((line) => {
    const [name, carrier, speed] = line.trim().split(/\s+/);
    if (!name) return [];
    const mbps = Number(speed);
    return [{ name, up: carrier === "1", ...(Number.isFinite(mbps) && mbps > 0 ? { speed: mbps } : {}) }];
  });

/** "<device> <adverts sent> <solicits heard>" per line. */
export const parseAdverts = (text: string): Adverts[] =>
  text.split("\n").flatMap((line) => {
    const [device, sent, solicits] = line.trim().split(/\s+/);
    return device && sent !== undefined ? [{ device, sent: Number(sent) || 0, solicits: Number(solicits) || 0 }] : [];
  });

/** `ip neigh show`: "<address> dev <dev> lladdr <mac> [router] <STATE>"; entries without a MAC skipped. */
export const parseNeighbourTable = (text: string): NeighbourEntry[] =>
  text.split("\n").flatMap((line) => {
    const m = /^(\S+)\s.*\blladdr\s+([0-9a-f:]{17})\b.*\s([A-Z]+)\s*$/i.exec(line.trim());
    return m ? [{ address: m[1], mac: m[2].toLowerCase(), state: m[3] }] : [];
  });

/** A MAC inside a DUID: DUID-LLT (0001, hardware type, time) and DUID-LL (0003, hardware type). */
const macOfDuid = (duid: string) => {
  const hex = duid.toLowerCase().replace(/[^0-9a-f]/g, "");
  const mac = hex.startsWith("00010001") && hex.length === 28 ? hex.slice(16) : hex.startsWith("00030001") && hex.length === 20 ? hex.slice(8) : undefined;
  return mac?.match(/../g)?.join(":");
};

/** `ubus call dhcp ipv6leases`: per device, each lease's DUID, hostname and addresses. */
export const parseIpv6Leases = (value: unknown): Ipv6Lease[] =>
  Object.values(obj(obj(value).device)).flatMap((device) =>
    arr(obj(device).leases)
      .map(obj)
      .flatMap((lease) => {
        const duid = str(lease.duid);
        if (!duid) return [];
        const mac = macOfDuid(duid);
        const addresses = arr(lease["ipv6-addr"]).map(obj).flatMap((a) => (str(a.address) ? [str(a.address)!] : []));
        return [{ duid, ...(mac ? { mac } : {}), ...(str(lease.hostname) ? { hostname: str(lease.hostname) } : {}), addresses }];
      })
  );

/**
 * The Internet view's checks, one per line: "ping <avg ms or ->", "ip <address
 * or ->", "dns <ok or fail>", then "qdisc <device> <sent bytes> <dropped>" per
 * shaped device.
 */
export const parseInternetCheck = (text: string): InternetCheck => {
  const lines = text.split("\n").map((l) => l.trim().split(/\s+/));
  const field = (key: string) => lines.find((l) => l[0] === key)?.[1];
  const ping = Number(field("ping"));
  const ip = field("ip");
  return {
    ...(Number.isFinite(ping) && ping > 0 ? { latencyMs: ping } : {}),
    ...(ip && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) ? { publicIpv4: ip } : {}),
    dnsOk: field("dns") === "ok",
    queues: lines.filter((l) => l[0] === "qdisc" && l.length >= 4).map(([, device, sent, dropped]) => ({
      device,
      sentBytes: Number(sent) || 0,
      dropped: Number(dropped) || 0,
    })),
  };
};

/** logread's lines: "<Day Mon DD HH:MM:SS YYYY> <facility.level> <tag>: <message>". */
export const parseLog = (text: string): LogLine[] =>
  text.split("\n").flatMap((line) => {
    const m = /^\w{3} (\w{3}) +(\d+) (\d\d:\d\d:\d\d) (\d{4}) \S+ (.*)$/.exec(line.trim());
    if (!m) return [];
    const at = Date.parse(`${m[1]} ${m[2]} ${m[4]} ${m[3]}`);
    return Number.isFinite(at) ? [{ at, text: m[5] }] : [];
  });

const storage = raw("df -k /overlay 2>/dev/null || df -k / 2>/dev/null");
const temperature = raw("cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null || true");
// Devices with hardware behind them (a port, a radio), not bridges or VLANs.
const links = raw(
  'for d in /sys/class/net/*; do [ -e "$d/device" ] || [ -e "$d/phys_port_name" ] || continue; echo "${d##*/} $(cat "$d/carrier" 2>/dev/null || echo 0) $(cat "$d/speed" 2>/dev/null || echo -1)"; done'
);
const adverts = raw(
  'for f in /proc/net/dev_snmp6/*; do awk -v n="${f##*/}" \'$1=="Icmp6OutRouterAdvertisements"{o=$2} $1=="Icmp6InRouterSolicits"{i=$2} END{if (o + i > 0) print n, o + 0, i + 0}\' "$f"; done'
);
const neighbourTable = raw("ip neigh show 2>/dev/null || true");
const ipv6Leases: Probe<unknown> = {
  command: "ubus call dhcp ipv6leases 2>/dev/null || echo '{}'",
  parse: ({ stdout }) => json(stdout || "{}", "dhcp ipv6leases"),
};

/** The Internet view's checks, from the router (see parseInternetCheck). */
const internetCheck = (shaped: string[]) =>
  raw(
    [
      `echo "ping $(ping -c 3 -W 2 1.1.1.1 2>/dev/null | sed -n 's/.*= [0-9.]*\\/\\([0-9.]*\\)\\/.*/\\1/p')"`,
      `echo "ip $(uclient-fetch -q -T 4 -O - https://api.ipify.org 2>/dev/null | head -c 15)"`,
      `nslookup openwrt.org 127.0.0.1 >/dev/null 2>&1 && echo "dns ok" || echo "dns fail"`,
      ...shaped.map(
        (device) =>
          `tc -s qdisc show dev ${device} 2>/dev/null | awk '/Sent/ {print "qdisc ${device}", $2, $7 + 0; exit}' | tr -d ','`
      ),
    ].join("; ")
  );

/** What happened lately worth telling: links, interfaces, reboots, this app's own marks (see the Activity view). */
const logProbe = raw(
  "logread -l 400 2>/dev/null | grep -E 'onc|netifd: Interface|link is (up|down)|odhcpd.*(Failed|error)|AP-ENABLED|AP-DISABLED|init complete|mwan3.*(online|offline)' | tail -n 120"
);

/** What only some views read: the Internet view's checks, the Activity view's log. */
export type StatusExtras = { internet?: { shaped: string[] }; log?: boolean };

/** Read what `hostname` is doing, over an open session. */
export const readDeviceStatus = async (
  hostname: string,
  session: Session,
  now: () => number,
  /** The services the settings say must run there. */
  mustRun: string[] = [],
  extras: StatusExtras = {}
): Promise<DeviceStatus> => {
  const read = await runProbes(session, {
    systemInfo,
    interfaces,
    wifi,
    leases,
    mwan3,
    originators,
    handshakes,
    meshWired,
    storage,
    temperature,
    links,
    adverts,
    neighbourTable,
    ipv6Leases,
    notRunning: notRunning(mustRun),
    // Device names only (eth1, pppoe-wan): they go inside an awk program, unquoted.
    internetCheck: extras.internet
      ? internetCheck(extras.internet.shaped.filter((d) => /^[A-Za-z0-9._@-]+$/.test(d)))
      : raw("true"),
    log: extras.log ? logProbe : raw("true"),
  });
  const storageRead = parseStorage(read.storage);
  const temperatureRead = parseTemperature(read.temperature);
  return {
    hostname,
    readAt: now(),
    ...parseSystemInfo(read.systemInfo),
    interfaces: parseInterfaces(read.interfaces),
    wifi: parseWifi(read.wifi),
    leases: parseLeases(read.leases),
    lines: parseLines(read.mwan3),
    mesh: parseOriginators(read.originators),
    ...(read.meshWired
      ? { meshWiredMtu: read.meshWired.mtu, meshWiredPath: { small: read.meshWired.small, large: read.meshWired.large } }
      : {}),
    wireguard: parseHandshakes(read.handshakes),
    ...(storageRead ? { storage: storageRead } : {}),
    ...(temperatureRead !== undefined ? { temperature: temperatureRead } : {}),
    links: parseLinks(read.links),
    adverts: parseAdverts(read.adverts),
    neighbours: parseNeighbourTable(read.neighbourTable),
    ipv6Leases: parseIpv6Leases(read.ipv6Leases),
    notRunning: read.notRunning,
    ...(extras.internet ? { internet: parseInternetCheck(read.internetCheck) } : {}),
    ...(extras.log ? { log: parseLog(read.log) } : {}),
  };
};

/** The probes' commands, to record their output on a real image (src/tests/helpers/status/). */
export const statusCommands = {
  storage: storage.command,
  temperature: temperature.command,
  links: links.command,
  adverts: adverts.command,
  neighbourTable: neighbourTable.command,
  ipv6Leases: ipv6Leases.command,
  internetCheck: internetCheck(["eth0"]).command,
  log: logProbe.command,
};
