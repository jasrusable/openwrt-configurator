// What one device is doing now, read in one round trip: the same `ubus call`s
// LuCI's status pages make, run over SSH for now. Their JSON is exactly what
// ubus over HTTPS will return once the read-only monitor login exists, so
// these parsers stay and only the transport changes (CLAUDE.md, "Reading
// devices"). Parsing is defensive: a field a release lacks is left out, never
// an error. Nothing here prints a config value.
import { Probe, notRunning, runProbes } from "../../deviceProbes";
import type { Session } from "../../platform";
import { adverts, ipv6Leases, leases, neighbourTable, parseAdverts, parseIpv6Leases, parseLeases, parseNeighbourTable, parseTraffic, traffic } from "./clients";
import { raw } from "./common";
import { internetCheck, mwan3, parseInternetCheck, parseLines } from "./internet";
import { logProbe, parseLog } from "./log";
import { mdns, parseMdns } from "./mdns";
import { meshWired, MeshWiredLink, originators, parseOriginators } from "./mesh";
import { cores, counters, interfaces, links, parseCounters, parseInterfaces, parseLinks, parseStorage, parseSystemInfo, parseTemperature, storage, systemInfo, temperature } from "./system";
import type { DeviceStatus } from "./types";
import { handshakes, parseHandshakes } from "./vpn";
import { heardBy, parseHeardBy, parseWifi, wifi } from "./wifi";

export { leasesCommand, parseAdverts, parseIpv6Leases, parseLeases, parseNeighbourTable, parseTraffic } from "./clients";
export { internetCheckSeconds, latencyTarget, parseInternetCheck, parseLines, parsePingOutput, pingNumbers } from "./internet";
export { parseLog } from "./log";
export { parseMdns } from "./mdns";
export { meshWired, meshWiredLink, parseOriginators, parseRoutes } from "./mesh";
export { parseCounters, parseInterfaces, parseLinks, parseStorage, parseSystemInfo, parseTemperature } from "./system";
export type { Adverts, DeviceStatus, MdnsDevice, InterfaceStatus, InternetCheck, Ipv6Lease, Lease, LineStatus, LogLine, MeshNeighbour, NeighbourEntry, PortLink, WifiClient, WifiInterface, WireguardPeer } from "./types";
export { parseHandshakes } from "./vpn";
export { parseHeardBy, parseWifi } from "./wifi";

/**
 * What only some views read: the Performance view's checks, the Activity
 * view's log, and the costlier reads only the pages showing them make (the
 * wired mesh's pings, nlbwmon's counts, usteer's view). Absent: not read.
 */
export type StatusExtras = {
  /** The router's checks: the devices smart queueing shapes, and each DNS-over-HTTPS instance's port to ask. */
  internet?: { shaped: string[]; doh?: number[] };
  log?: boolean;
  /** The wired mesh's link there (meshWiredLink: its VLAN device, and what carries it). */
  meshWired?: MeshWiredLink;
  traffic?: boolean;
  heardBy?: boolean;
  /** What devices say of themselves over mDNS (the router's umdns). */
  mdns?: boolean;
};

/** A probe not made this time: its answer is the given value. */
const skipped = <T>(value: T): Probe<T> => ({ command: "true", parse: () => value });

/** Read what `hostname` is doing, over an open session. */
export const readDeviceStatus = async (
  hostname: string,
  session: Session,
  now: () => number,
  /** The services the settings say must run there. */
  mustRun: string[] = [],
  extras: StatusExtras = {}
): Promise<DeviceStatus> => {
  // Only the system's own answer is required: anything else that cannot be
  // read is left out and named, so one odd answer does not make the device
  // look unreachable.
  const unread: string[] = [];
  const tolerant = <T>(name: string, probe: Probe<T>, fallback: T): Probe<T> => ({
    ...probe,
    parse: (result) => {
      try {
        return probe.parse(result);
      } catch {
        unread.push(name);
        return fallback;
      }
    },
  });
  const read = await runProbes(session, {
    systemInfo,
    interfaces: tolerant("network interfaces", interfaces, undefined),
    wifi: tolerant("Wi-Fi", wifi, undefined),
    leases,
    mwan3: tolerant("mwan3", mwan3, undefined),
    originators,
    handshakes,
    meshWired: extras.meshWired ? tolerant("the wired mesh", meshWired(extras.meshWired), undefined) : skipped(undefined),
    storage,
    temperature,
    links,
    adverts,
    neighbourTable,
    ipv6Leases: tolerant("IPv6 leases", ipv6Leases, undefined),
    notRunning: tolerant("services", notRunning(mustRun), []),
    counters,
    cores,
    traffic: extras.traffic ? tolerant("traffic (nlbwmon)", traffic, undefined) : skipped(undefined),
    heardBy: extras.heardBy ? tolerant("roaming (usteer)", heardBy, undefined) : skipped(undefined),
    mdns: extras.mdns ? tolerant("device names (umdns)", mdns, { browse: undefined, hosts: undefined }) : skipped({ browse: undefined, hosts: undefined }),
    // Device names only (eth1, pppoe-wan): they go inside an awk program, unquoted.
    internetCheck: extras.internet
      ? internetCheck(
          extras.internet.shaped.filter((d) => /^[A-Za-z0-9._@-]+$/.test(d)),
          (extras.internet.doh ?? []).filter((p) => Number.isInteger(p) && p > 0 && p < 65536)
        )
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
      ? {
          meshWiredMtu: read.meshWired.mtu,
          meshWiredPath: { small: read.meshWired.small, large: read.meshWired.large },
          ...(extras.meshWired && !extras.meshWired.large ? { meshWiredSplits: true } : {}),
        }
      : {}),
    wireguard: parseHandshakes(read.handshakes),
    ...(storageRead ? { storage: storageRead } : {}),
    ...(temperatureRead !== undefined ? { temperature: temperatureRead } : {}),
    links: parseLinks(read.links),
    adverts: parseAdverts(read.adverts),
    neighbours: parseNeighbourTable(read.neighbourTable),
    ipv6Leases: parseIpv6Leases(read.ipv6Leases),
    notRunning: read.notRunning,
    unread,
    counters: parseCounters(read.counters),
    ...(Number(read.cores) > 0 ? { cores: Number(read.cores) } : {}),
    traffic: parseTraffic(read.traffic),
    heardBy: parseHeardBy(read.heardBy),
    mdns: parseMdns(read.mdns),
    ...(extras.internet ? { internet: parseInternetCheck(read.internetCheck) } : {}),
    ...(extras.log ? { log: parseLog(read.log) } : {}),
  };
};
