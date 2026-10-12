// The network's status, interpreted against the saved settings. A device may
// not match them (never applied, changed by hand, an old config), so this
// never assumes it does: what lines up is matched (interface lan is network
// lan, an SSID with your SSID's name is that SSID), and what does not is
// listed as unexpected, never hidden. Pure: tested against recorded output.
import { ipv6Interface } from "../intent/connections";
import type { Intent } from "../intent/schema";
import { DeviceStatus } from "./device";

export type Reachability = DeviceStatus | { hostname: string; error: string };

export type NetworkStatus = {
  /** Up when any connection is; its addresses the first working one's. Absent when the router was not reached. */
  internet?: { up: boolean; ipv4: string[]; ipv6: string[]; uptime?: number };
  /**
   * Each connection, from its interfaces on the router (wan, and wan6 for
   * the main one), and with several, mwan3's view: whether the line works
   * (`line`), for how long, and whether it carries traffic now (`inUse`).
   */
  connections: {
    id: string;
    name: string;
    up?: boolean;
    ipv4: string[];
    ipv6: string[];
    uptime?: number;
    line?: { state: string; since: number };
    inUse?: boolean;
  }[];
  devices: {
    name: string;
    role: string;
    /** Absent when it could not be reached. */
    health?: { uptime: number; load: number; memoryUsed: number };
    error?: string;
  }[];
  networks: { id: string; name: string; up?: boolean; clients: number }[];
  ssids: { ssid: string; accessPoints: string[]; clients: number }[];
  clients: { total: number; wifi: number };
  /**
   * With the mesh on: each device reached, and the nodes it links to
   * directly (by name where its MAC is known from facts) with the quality.
   */
  mesh?: { name: string; links: { to: string; quality: number }[] }[];
  /** On the devices but not in your settings: shown, so a mismatch is never hidden. */
  unexpected: { interfaces: string[]; ssids: string[] };
};

const reached = (r: Reachability | undefined): r is DeviceStatus => !!r && !("error" in r);

/** The /24 a network hands addresses out in: "10.0.20." for 10.0.20.0/24. */
const prefixOf = (subnet: string) => subnet.split(".").slice(0, 3).join(".") + ".";

export const networkStatus = (
  intent: Intent,
  devices: Reachability[],
  /** Each device's MACs (from its facts): who a mesh neighbour is. */
  macs: Record<string, string[] | undefined> = {}
): NetworkStatus => {
  const byName = new Map(devices.map((d) => [d.hostname, d]));
  const routerName = intent.hardware.find((d) => d.role === "router")?.name;
  const router = routerName ? byName.get(routerName) : undefined;
  const routerUp = reached(router) ? router : undefined;
  const iface = (id: string) => routerUp?.interfaces.find((i) => i.id === id);
  const lineOf = (id: string) => routerUp?.lines.find((l) => l.id === id);
  // A line works when mwan3 says so (still, while it is only failing); with
  // one connection and no mwan3, when its interface is up.
  const works = (c: Intent["internet"]["connections"][number]) => {
    const line = lineOf(c.id);
    return line ? line.state === "online" || line.state === "disconnecting" : !!iface(c.id)?.up;
  };
  const all = intent.internet.connections;
  const working = all.filter(works);
  // Which carry traffic now: the first working one in failover; sharing,
  // every working one, a metered line only when nothing else works.
  const carrying =
    intent.internet.mode === "balance" && all.length > 1
      ? working.some((c) => !c.metered)
        ? working.filter((c) => !c.metered)
        : working
      : working.slice(0, 1);
  const connections = all.map((c) => {
    const v4 = iface(c.id);
    const v6 = iface(ipv6Interface(c));
    const line = lineOf(c.id);
    return {
      id: c.id,
      name: c.name,
      ...(routerUp ? { up: !!v4?.up, inUse: carrying.includes(c) } : {}),
      ipv4: v4?.ipv4 ?? [],
      ipv6: [...(v4?.ipv6 ?? []), ...(v6?.ipv6 ?? [])],
      ...(v4?.uptime !== undefined ? { uptime: v4.uptime } : {}),
      ...(line ? { line: { state: line.state, since: line.since } } : {}),
    };
  });
  const inUse = connections.find((c) => c.inUse);
  const leases = routerUp?.leases ?? [];
  const accessPoints = intent.hardware.filter((d) => d.role === "access-point");
  const radios = accessPoints.flatMap((ap) => {
    const status = byName.get(ap.name);
    return reached(status) ? status.wifi.map((w) => ({ ap: ap.name, ...w })) : [];
  });
  const known = new Set([
    ...intent.internet.connections.flatMap((c) => [c.id, ipv6Interface(c)]),
    ...intent.networks.map((n) => n.id),
  ]);
  const ssids = new Set(intent.wifi.map((w) => w.ssid));
  return {
    ...(routerUp
      ? {
          internet: {
            up: !!inUse,
            ipv4: inUse?.ipv4 ?? [],
            ipv6: connections[0]?.ipv6 ?? [],
            ...(inUse?.uptime !== undefined ? { uptime: inUse.uptime } : {}),
          },
        }
      : {}),
    connections,
    ...(intent.mesh?.enabled
      ? {
          mesh: intent.hardware.flatMap((d) => {
            const status = byName.get(d.name);
            if (!reached(status)) return [];
            const nameOf = (mac: string) =>
              Object.entries(macs).find(([, list]) => list?.includes(mac))?.[0] ?? mac;
            return [{ name: d.name, links: status.mesh.map((n) => ({ to: nameOf(n.mac), quality: n.quality })) }];
          }),
        }
      : {}),
    devices: intent.hardware.map((d) => {
      const status = byName.get(d.name);
      return {
        name: d.name,
        role: d.role,
        ...(reached(status)
          ? {
              health: {
                uptime: status.uptime,
                load: status.load[0],
                memoryUsed: status.memory.total
                  ? 1 - status.memory.available / status.memory.total
                  : 0,
              },
            }
          : { error: status && "error" in status ? status.error : "not read" }),
      };
    }),
    networks: intent.networks.map((n) => ({
      id: n.id,
      name: n.name,
      ...(routerUp ? { up: !!iface(n.id)?.up } : {}),
      clients: leases.filter((l) => l.address.startsWith(prefixOf(n.subnet))).length,
    })),
    ssids: intent.wifi.map((w) => {
      const on = radios.filter((r) => r.ssid === w.ssid);
      return {
        ssid: w.ssid,
        accessPoints: [...new Set(on.map((r) => r.ap))],
        clients: on.reduce((sum, r) => sum + r.clients.length, 0),
      };
    }),
    clients: {
      total: new Set([...leases.map((l) => l.mac), ...radios.flatMap((r) => r.clients.map((c) => c.mac))]).size,
      wifi: new Set(radios.flatMap((r) => r.clients.map((c) => c.mac))).size,
    },
    unexpected: {
      interfaces: (routerUp?.interfaces ?? []).map((i) => i.id).filter((id) => !known.has(id)),
      ssids: [...new Set(radios.flatMap((r) => (r.ssid && !ssids.has(r.ssid) ? [r.ssid] : [])))],
    },
  };
};
