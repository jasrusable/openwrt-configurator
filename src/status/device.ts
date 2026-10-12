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
  const read = await runProbes(session, { systemInfo, interfaces, wifi, leases });
  return {
    hostname,
    readAt: now(),
    ...parseSystemInfo(read.systemInfo),
    interfaces: parseInterfaces(read.interfaces),
    wifi: parseWifi(read.wifi),
    leases: parseLeases(read.leases),
  };
};
