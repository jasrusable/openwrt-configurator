// The network's status, interpreted against the saved settings. A device may
// not match them (never applied, changed by hand, an old config), so this
// never assumes it does: what lines up is matched (interface lan is network
// lan, an SSID with your SSID's name is that SSID), and what does not is
// listed as unexpected, never hidden. Pure: tested against recorded output.
import { meshMtu } from "../intent/mesh";
import { failoverOrder, ipv6Interface } from "../intent/connections";
import type { Intent } from "../intent/schema";
import type { DeviceFailure } from "../readEach";
import type { Result } from "../result";
import { DeviceStatus, InternetCheck } from "./device";
import type { ActivityView, Attention, ClientView, DeviceView, RadioView } from "./views";


/** A mesh link slower than this (BATMAN_V's estimate) shows as weak: below it, a cable or a nearer node would help. */
export const weakMeshLinkMbps = 20;
/** A device's read: what it said, or why it could not be read. */
export type Reachability = Result<DeviceStatus, DeviceFailure>;

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
  // The Status pages' views (views.ts), added by readNetworkStatus.
  attention?: Attention[];
  clientList?: ClientView[];
  deviceViews?: DeviceView[];
  radios?: RadioView[];
  internetCheck?: InternetCheck;
  activity?: ActivityView[];
  /** Each internet line's byte counters, and when: two reads give the throughput. */
  internetCounters?: { lines: Record<string, { rx: number; tx: number }>; at: number };
  /** Bits per second now, from this read's counters and the one before (the collector's). */
  throughput?: { down?: number; up?: number };
  /** When this was read, by the server's clock. */
  readAt?: number;
  /** Read before an apply that is running now: the devices are not read meanwhile. */
  applying?: boolean;
};

/** What a device said, if it was read. */
export const reached = (r: Reachability | undefined): DeviceStatus | undefined => (r?.ok ? r.value : undefined);

/** Why a device was not read: what it said when it failed, or that it was not read at all. */
export const whyUnread = (r: Reachability | undefined) => (r && !r.ok ? r.error.message : undefined);

/** Every device that was read. */
export const readDevices = (devices: Reachability[]): DeviceStatus[] => devices.flatMap((r) => (r.ok ? [r.value] : []));

/** The read of the device of that name. */
export const readOf = (devices: Reachability[], name: string | undefined) =>
  devices.find((r) => (r.ok ? r.value.hostname : r.error.hostname) === name);

/** What the router said (or why not), as the settings name it. */
export const routerOf = (intent: Intent, devices: Reachability[]) =>
  readOf(devices, intent.hardware.find((d) => d.role === "router")?.name);

/** The network an IPv4 address is in: each hands out its /24 ("10.0.20." for 10.0.20.0/24). */
export const networkOfAddress = (intent: Intent, address: string) =>
  intent.networks.find((n) => address.startsWith(n.subnet.split(".").slice(0, 3).join(".") + "."));

export const networkStatus = (
  intent: Intent,
  devices: Reachability[],
  /** Each device's MACs (from its facts): who a mesh neighbour is. */
  macs: Record<string, string[] | undefined> = {}
): NetworkStatus => {
  const statusOf = (name: string) => reached(readOf(devices, name));
  const routerUp = reached(routerOf(intent, devices));
  const iface = (id: string) => routerUp?.interfaces.find((i) => i.id === id);
  const lineOf = (id: string) => routerUp?.lines.find((l) => l.id === id);
  // A line works when mwan3 says so (still, while it is only failing); with
  // one connection and no mwan3, when its interface is up.
  const works = (c: Intent["internet"]["lines"][number]) => {
    const line = lineOf(c.id);
    return line ? line.state === "online" || line.state === "disconnecting" : !!iface(c.id)?.up;
  };
  const all = intent.internet.lines;
  const working = all.filter(works);
  // Which carry traffic now: the first working one in failover; sharing,
  // every working one, a metered line only when nothing else works.
  const carrying =
    intent.internet.use_lines.mode === "balance" && all.length > 1
      ? working.some((c) => !c.failover.metered)
        ? working.filter((c) => !c.failover.metered)
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
  // Clients only: our own devices (the access points) hold leases too.
  const ours = new Set(Object.values(macs).flatMap((m) => m ?? []));
  const leases = (routerUp?.leases ?? []).filter((l) => !ours.has(l.mac));
  const accessPoints = intent.hardware.filter((d) => d.role === "access-point");
  const radios = accessPoints.flatMap((ap) => {
    return (statusOf(ap.name)?.wifi ?? []).map((w) => ({ ap: ap.name, ...w }));
  });
  // Every interface the compiler writes on the router: its lines, networks,
  // VPN (intent/vpn) and mesh (intent/mesh).
  const known = new Set([
    ...intent.internet.lines.flatMap((c) => [c.id, ipv6Interface(c)]),
    ...intent.networks.map((n) => n.id),
    ...(intent.vpn.remote_access.enabled ? ["vpn"] : []),
    ...(intent.vpn.sites?.peers.length ? ["sites"] : []),
    ...(intent.vpn.providers ?? []).map((t) => t.id),
    ...(intent.wifi.mesh?.enabled ? ["bat0", "batmesh", "batwired"] : []),
  ]);
  const ssids = new Set(intent.wifi.networks.map((w) => w.ssid));
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
    ...(routerUp && (intent.vpn.remote_access.enabled || intent.vpn.sites?.peers.length || intent.vpn.providers?.length)
      ? {
          vpn: {
            clients: (intent.vpn.remote_access.enabled ? intent.vpn.remote_access.clients : []).map((c) => ({
              name: c.name,
              since: routerUp.wireguard.find((p) => p.iface === "vpn" && p.publicKey === c.public_key)?.since,
            })),
            sites: (intent.vpn.sites?.peers ?? []).map((s) => ({
              name: s.name,
              since: routerUp.wireguard.find((p) => p.iface === "sites" && p.publicKey === s.public_key)?.since,
            })),
            // A tunnel is up when its interface is, and a WireGuard one has a recent handshake.
            tunnels: (intent.vpn.providers ?? []).map((t) => {
              const shake = routerUp.wireguard.find((p) => p.iface === t.id)?.since;
              return { name: t.name, up: !!iface(t.id)?.up && (t.type !== "wireguard" || (shake !== undefined && shake < 180)) };
            }),
          },
        }
      : {}),
    ...(intent.wifi.mesh?.enabled
      ? {
          mesh: intent.hardware.flatMap((d) => {
            const status = statusOf(d.name);
            if (!status) return [];
            const nameOf = (mac: string) =>
              Object.entries(macs).find(([, list]) => list?.includes(mac))?.[0] ?? mac;
            // Direct: the next hop is the node itself, by any of its MACs.
            const direct = status.mesh.filter((n) => n.originator === n.mac || nameOf(n.originator) === nameOf(n.mac));
            return [
              {
                name: d.name,
                links: direct.map((n) => ({ to: nameOf(n.mac), throughput: n.throughput })),
                // Over cables, a port that would not take batman's frames: it fragments there.
                // Only where large frames are asked for and the link can carry them: else splitting is the plan.
                ...(intent.wifi.mesh.over_cable &&
                intent.wifi.mesh.large_frames &&
                !status.meshWiredSplits &&
                status.meshWiredMtu !== undefined &&
                status.meshWiredMtu < meshMtu
                  ? { fragmentsOverCable: true }
                  : {}),
                ...(intent.wifi.mesh.over_cable && status.meshWiredPath && status.meshWiredPath.large < status.meshWiredPath.small
                  ? { dropsLargeFrames: true }
                  : {}),
              },
            ];
          }),
        }
      : {}),
    devices: intent.hardware.map((d) => {
      const read = readOf(devices, d.name);
      const status = reached(read);
      return {
        name: d.name,
        role: d.role,
        ...(status
          ? {
              health: {
                uptime: status.uptime,
                load: status.load[0],
                memoryUsed: status.memory.total
                  ? 1 - status.memory.available / status.memory.total
                  : 0,
              },
            }
          : { error: whyUnread(read) ?? "not read" }),
      };
    }),
    networks: intent.networks.map((n) => ({
      id: n.id,
      name: n.name,
      ...(routerUp ? { up: !!iface(n.id)?.up } : {}),
      clients: leases.filter((l) => networkOfAddress(intent, l.address)?.id === n.id).length,
    })),
    ssids: intent.wifi.networks.map((w) => {
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
