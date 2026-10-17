// The device itself: uptime, load and memory, interfaces, storage,
// temperature, its ports' links and byte counters.
import type { Probe } from "../../deviceProbes";
import { arr, num, obj, str } from "../values";
import { json, raw } from "./common";
import type { InterfaceStatus, PortLink } from "./types";

/**
 * `ubus call system info`: uptime, load (×65536 there), memory. The one
 * answer a read needs: without an uptime, ubus did not answer (wedged, it
 * prints nothing), and the device is not read rather than taken for one
 * just booted.
 */
export const parseSystemInfo = (info: unknown) => {
  const o = obj(info);
  const uptime = num(o.uptime);
  if (uptime === undefined) throw new Error("its system did not answer (ubus)");
  const load = arr(o.load).map((l) => (num(l) ?? 0) / 65536);
  const memory = obj(o.memory);
  return {
    uptime,
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
      ...(str(i.proto) ? { proto: str(i.proto) } : {}),
      ...(() => {
        // The default route: target 0.0.0.0 (:: on wan6), mask 0; its next hop is the gateway.
        const route = arr(i.route).map(obj).find((r) => (r.target === "0.0.0.0" || r.target === "::") && Number(r.mask) === 0 && str(r.nexthop));
        return route && route.nexthop !== "0.0.0.0" && route.nexthop !== "::" ? { gateway: str(route.nexthop)! } : {};
      })(),
      ...(() => {
        const prefixes = arr(i["ipv6-prefix"]).map(obj).flatMap((p) => (str(p.address) ? [`${p.address}/${p.mask}`] : []));
        return prefixes.length ? { prefixes } : {};
      })(),
      ...(() => {
        const dns = arr(i["dns-server"]).flatMap((d) => (str(d) ? [str(d)!] : []));
        return dns.length ? { dns } : {};
      })(),
    }));

export const systemInfo: Probe<unknown> = {
  command: "ubus call system info",
  parse: ({ stdout }) => json(stdout, "system info"),
};

export const interfaces: Probe<unknown> = {
  command: "ubus call network.interface dump",
  parse: ({ stdout }) => json(stdout, "network.interface dump"),
};

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

/** "<device> <rx bytes> <tx bytes>" per line. */
export const parseCounters = (text: string) =>
  Object.fromEntries(
    text.split("\n").flatMap((line) => {
      const [device, rx, tx] = line.trim().split(/\s+/);
      return device && rx !== undefined && tx !== undefined && /^\d+$/.test(rx) && /^\d+$/.test(tx)
        ? [[device, { rx: Number(rx), tx: Number(tx) }]]
        : [];
    })
  );

export const counters = raw(
  'for d in /sys/class/net/*; do echo "${d##*/} $(cat "$d/statistics/rx_bytes" 2>/dev/null) $(cat "$d/statistics/tx_bytes" 2>/dev/null)"; done'
);

export const cores = raw("grep -c ^processor /proc/cpuinfo 2>/dev/null || true");

export const storage = raw("df -k /overlay 2>/dev/null || df -k / 2>/dev/null");

export const temperature = raw("cat /sys/class/thermal/thermal_zone*/temp 2>/dev/null || true");

// Devices with hardware behind them (a port, a radio), not bridges or VLANs.
export const links = raw(
  'for d in /sys/class/net/*; do [ -e "$d/device" ] || [ -e "$d/phys_port_name" ] || continue; echo "${d##*/} $(cat "$d/carrier" 2>/dev/null || echo 0) $(cat "$d/speed" 2>/dev/null || echo -1)"; done'
);
