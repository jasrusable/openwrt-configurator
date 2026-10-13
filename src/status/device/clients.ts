// Who is on the network: DHCP leases (v4 and v6), the neighbour table,
// router adverts and solicits heard, and per-client traffic (nlbwmon).
import type { Probe } from "../../deviceProbes";
import { arr, num, obj, str } from "../values";
import { json, keptInRam, raw } from "./common";
import type { Adverts, Ipv6Lease, Lease, NeighbourEntry } from "./types";

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

export const leases: Probe<string> = {
  command: leasesCommand,
  parse: ({ stdout }) => stdout,
};

/** "<device> <adverts sent> <solicits heard>" per line. */
export const parseAdverts = (text: string): Adverts[] => {
  // "<dev> <sent> <solicits>" lines, then "before <seconds>" and the earlier lines.
  const [now, earlier = ""] = text.split(/^before\s+/m);
  const lines = (block: string) =>
    block.split("\n").flatMap((line) => {
      const [device, sent, solicits] = line.trim().split(/\s+/);
      return device && sent !== undefined ? [{ device, sent: Number(sent) || 0, solicits: Number(solicits) || 0 }] : [];
    });
  const seconds = Number(earlier.split("\n")[0]);
  const before = lines(earlier.split("\n").slice(1).join("\n"));
  return lines(now).map((a) => {
    const b = before.find((x) => x.device === a.device);
    return b && seconds > 0 && a.sent >= b.sent && a.solicits >= b.solicits
      ? { ...a, before: { sent: b.sent, solicits: b.solicits, seconds } }
      : a;
  });
};

// The counts now, then those kept in the router's RAM from a read at least
// two minutes ago (renewed once they are older than that), as "before <age>".
export const adverts = raw(
  [
    keptInRam,
    'p=$s/adverts; t=$(cut -d. -f1 /proc/uptime)',
    'for f in /proc/net/dev_snmp6/*; do awk -v n="${f##*/}" \'$1=="Icmp6OutRouterAdvertisements"{o=$2} $1=="Icmp6InRouterSolicits"{i=$2} END{if (o + i > 0) print n, o + 0, i + 0}\' "$f"; done > $p.now',
    'cat $p.now',
    'a=$(cat $p.at 2>/dev/null); [ -n "$a" ] && [ "$a" -le "$t" ] && { echo "before $((t - a))"; cat $p 2>/dev/null; }',
    '{ [ -z "$a" ] || [ "$a" -gt "$t" ] || [ $((t - a)) -ge 120 ]; } && mv $p.now $p && echo $t > $p.at || rm -f $p.now',
  ].join("; ")
);

/** `ip neigh show`: "<address> dev <dev> lladdr <mac> [router] <STATE>"; entries without a MAC skipped. */
export const parseNeighbourTable = (text: string): NeighbourEntry[] =>
  text.split("\n").flatMap((line) => {
    const m = /^(\S+)\s.*\blladdr\s+([0-9a-f:]{17})\b.*\s([A-Z]+)\s*$/i.exec(line.trim());
    const device = /\bdev\s+(\S+)/.exec(line)?.[1];
    return m ? [{ address: m[1], mac: m[2].toLowerCase(), state: m[3], ...(device ? { device } : {}) }] : [];
  });

export const neighbourTable = raw("ip neigh show 2>/dev/null || true");

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

export const ipv6Leases: Probe<unknown> = {
  command: "ubus call dhcp ipv6leases 2>/dev/null || echo '{}'",
  parse: ({ stdout }) => json(stdout || "{}", "dhcp ipv6leases"),
};

/** `nlbw -c json -g mac`: columns, then a row per client. */
export const parseTraffic = (value: unknown) => {
  const o = obj(value);
  const columns = arr(o.columns).map((c) => str(c) ?? "");
  const at = (name: string) => columns.indexOf(name);
  return Object.fromEntries(
    arr(o.data).flatMap((row) => {
      const r = arr(row);
      const mac = str(r[at("mac")]);
      const rx = num(r[at("rx_bytes")]);
      const tx = num(r[at("tx_bytes")]);
      return mac && rx !== undefined && tx !== undefined ? [[mac.toLowerCase(), { rx, tx }]] : [];
    })
  );
};

export const traffic: Probe<unknown> = {
  command: "nlbw -c json -g mac 2>/dev/null || echo '{}'",
  parse: ({ stdout }) => json(stdout || "{}", "nlbw"),
};
