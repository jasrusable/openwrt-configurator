// The network's status, interpreted against the saved settings. A device may
// not match them (never applied, changed by hand, an old config), so this
// never assumes it does: what lines up is matched (interface lan is network
// lan, an SSID with your SSID's name is that SSID), and what does not is
// listed as unexpected, never hidden. Pure: tested against recorded output.
import { meshMtu } from "../intent/features/mesh";
import { failoverOrder, ipv6Interface } from "../intent/connections";
import type { Intent } from "../intent/schema";
import { DeviceStatus } from "./device";


/** A mesh link slower than this (BATMAN_V's estimate) shows as weak: below it, a cable or a nearer node would help. */
export const weakMeshLinkMbps = 20;
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
  mesh?: {
    name: string;
    links: { to: string; throughput: number }[];
    /** Over cables, a port here takes only 1500: batman splits its frames, slower. */
    fragmentsOverCable?: boolean;
    /** Over cables, a switch between drops batman's larger frames: full-size packets are lost. */
    dropsLargeFrames?: boolean;
  }[];
  /**
   * Remote access's clients and the linked sites, by their keys: how long
   * since each last made a handshake (a few minutes is connected); and each
   * VPN provider's tunnel, up or not.
   */
  vpn?: {
    clients: { name: string; since?: number }[];
    sites: { name: string; since?: number }[];
    tunnels: { name: string; up: boolean }[];
  };
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
      : failoverOrder(working).slice(0, 1);
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
  // Every interface the compiler writes on the router: its lines, networks,
  // VPN (features/vpn.ts) and mesh (features/mesh.ts).
  const known = new Set([
    ...intent.internet.connections.flatMap((c) => [c.id, ipv6Interface(c)]),
    ...intent.networks.map((n) => n.id),
    ...(intent.vpn?.enabled ? ["vpn"] : []),
    ...(intent.sites?.peers.length ? ["sites"] : []),
    ...(intent.tunnels ?? []).map((t) => t.id),
    ...(intent.mesh?.enabled ? ["bat0", "batmesh", "batwired"] : []),
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
    ...(routerUp && (intent.vpn?.enabled || intent.sites?.peers.length || intent.tunnels?.length)
      ? {
          vpn: {
            clients: (intent.vpn?.enabled ? intent.vpn.clients : []).map((c) => ({
              name: c.name,
              since: routerUp.wireguard.find((p) => p.iface === "vpn" && p.publicKey === c.public_key)?.since,
            })),
            sites: (intent.sites?.peers ?? []).map((s) => ({
              name: s.name,
              since: routerUp.wireguard.find((p) => p.iface === "sites" && p.publicKey === s.public_key)?.since,
            })),
            // A tunnel is up when its interface is, and a WireGuard one has a recent handshake.
            tunnels: (intent.tunnels ?? []).map((t) => {
              const shake = routerUp.wireguard.find((p) => p.iface === t.id)?.since;
              return { name: t.name, up: !!iface(t.id)?.up && (t.type !== "wireguard" || (shake !== undefined && shake < 180)) };
            }),
          },
        }
      : {}),
    ...(intent.mesh?.enabled
      ? {
          mesh: intent.hardware.flatMap((d) => {
            const status = byName.get(d.name);
            if (!reached(status)) return [];
            const nameOf = (mac: string) =>
              Object.entries(macs).find(([, list]) => list?.includes(mac))?.[0] ?? mac;
            // Direct: the next hop is the node itself, by any of its MACs.
            const direct = status.mesh.filter((n) => n.originator === n.mac || nameOf(n.originator) === nameOf(n.mac));
            return [
              {
                name: d.name,
                links: direct.map((n) => ({ to: nameOf(n.mac), throughput: n.throughput })),
                // Over cables, a port that would not take batman's frames: it fragments there.
                ...(intent.mesh.wired && status.meshWiredMtu !== undefined && status.meshWiredMtu < meshMtu
                  ? { fragmentsOverCable: true }
                  : {}),
                ...(intent.mesh.wired && status.meshWiredPath && status.meshWiredPath.large < status.meshWiredPath.small
                  ? { dropsLargeFrames: true }
                  : {}),
              },
            ];
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
