// The network's status, interpreted against the saved settings. A device may
// not match them (never applied, changed by hand, an old config), so this
// never assumes it does: what lines up is matched (interface lan is network
// lan, an SSID with your SSID's name is that SSID), and what does not is
// listed as unexpected, never hidden. Pure: tested against recorded output.
import type { Intent } from "../intent/schema";
import { DeviceStatus } from "./device";

export type Reachability = DeviceStatus | { hostname: string; error: string };

export type NetworkStatus = {
  /** From the router's wan and wan6; absent when the router was not reached. */
  internet?: { up: boolean; ipv4: string[]; ipv6: string[]; uptime?: number };
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
  /** On the devices but not in your settings: shown, so a mismatch is never hidden. */
  unexpected: { interfaces: string[]; ssids: string[] };
};

const reached = (r: Reachability | undefined): r is DeviceStatus => !!r && !("error" in r);

/** The /24 a network hands addresses out in: "10.0.20." for 10.0.20.0/24. */
const prefixOf = (subnet: string) => subnet.split(".").slice(0, 3).join(".") + ".";

export const networkStatus = (intent: Intent, devices: Reachability[]): NetworkStatus => {
  const byName = new Map(devices.map((d) => [d.hostname, d]));
  const routerName = intent.hardware.find((d) => d.role === "router")?.name;
  const router = routerName ? byName.get(routerName) : undefined;
  const routerUp = reached(router) ? router : undefined;
  const iface = (id: string) => routerUp?.interfaces.find((i) => i.id === id);
  const wan = iface("wan");
  const wan6 = iface("wan6");
  const leases = routerUp?.leases ?? [];
  const accessPoints = intent.hardware.filter((d) => d.role === "access-point");
  const radios = accessPoints.flatMap((ap) => {
    const status = byName.get(ap.name);
    return reached(status) ? status.wifi.map((w) => ({ ap: ap.name, ...w })) : [];
  });
  const known = new Set(["wan", "wan6", ...intent.networks.map((n) => n.id)]);
  const ssids = new Set(intent.wifi.map((w) => w.ssid));
  return {
    ...(routerUp
      ? {
          internet: {
            up: !!wan?.up,
            ipv4: wan?.ipv4 ?? [],
            ipv6: [...(wan?.ipv6 ?? []), ...(wan6?.ipv6 ?? [])],
            ...(wan?.uptime !== undefined ? { uptime: wan.uptime } : {}),
          },
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
