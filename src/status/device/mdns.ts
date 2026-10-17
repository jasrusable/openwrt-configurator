// What devices on the router's networks say of themselves over mDNS, as
// umdns (OpenWrt's own mDNS daemon, installed by the discovery feature) has
// heard it: their friendly names ("Jason's iPhone") and models
// (`model=iPhone15,2`). Read from its cache, then asked to look again at
// most once a minute (an mDNS query: no device changes, nothing configured).
// In that order: a look drops the services it re-asks for until their
// answers come back, a few seconds later (seen on 25.12.5), so the next read
// sees them, not this one.
import type { Probe } from "../../deviceProbes";
import { arr, obj, str } from "../values";
import { json, keptInRam, ubusCall } from "./common";
import type { MdnsDevice } from "./types";

export const mdns: Probe<{ browse: unknown; hosts: unknown }> = {
  command: [
    ubusCall,
    `printf '{"browse":'; call umdns browse '{"array":true}'`,
    `printf ',"hosts":'; call umdns hosts '{"array":true}'`,
    "printf '}'",
    keptInRam,
    't=$(cut -d. -f1 /proc/uptime); a=$(cat $s/mdns.at 2>/dev/null)',
    '{ [ -n "$a" ] && [ $((t - a)) -lt 60 ]; } || { ubus call umdns update >/dev/null 2>&1; echo $t > $s/mdns.at; }',
  ].join("\n"),
  parse: ({ stdout }) => {
    const both = obj(json(stdout, "umdns"));
    return { browse: both.browse, hosts: both.hosts };
  },
};

/** A service's instance name, where it names the device (not a printer queue's or a share's). */
const namingServices = ["_device-info._tcp", "_companion-link._tcp", "_airplay._tcp", "_raop._tcp", "_googlecast._tcp", "_homekit._tcp", "_hap._tcp"];

/** "host.local" without the domain. */
const labelOf = (host: string) => host.replace(/\.local\.?$/i, "");

const txtValue = (txt: unknown[], key: string) =>
  txt.map((t) => str(t)).find((t): t is string => !!t?.startsWith(`${key}=`))?.slice(key.length + 1);

/**
 * Each device heard, by host: what it is called (a naming service's instance,
 * else its host name), its addresses, its model where it says (Apple's
 * device-info `model`, a Cast device's `md`), and the services it offers.
 * Tolerant: an entry it cannot read is left out.
 */
export const parseMdns = ({ browse, hosts }: { browse: unknown; hosts: unknown }): MdnsDevice[] => {
  const entries = Object.entries(obj(browse)).flatMap(([service, instances]) =>
    Object.entries(obj(instances)).flatMap(([instance, raw]) => {
      const e = obj(raw);
      const host = str(e.host);
      if (!host) return [];
      const txt = arr(e.txt);
      return [
        {
          service,
          instance,
          host: host.toLowerCase(),
          spelt: host,
          addresses: [...arr(e.ipv4), ...arr(e.ipv6)].map(str).filter((a): a is string => !!a),
          model: service === "_device-info._tcp" ? txtValue(txt, "model") : service === "_googlecast._tcp" ? txtValue(txt, "md") : undefined,
          friendly: service === "_googlecast._tcp" ? txtValue(txt, "fn") : undefined,
        },
      ];
    })
  );
  const hostAddresses = Object.entries(obj(hosts)).map(([host, raw]) => ({
    host: host.toLowerCase(),
    spelt: host,
    addresses: [...arr(obj(raw).ipv4), ...arr(obj(raw).ipv6)].map(str).filter((a): a is string => !!a),
  }));
  const names = [...new Set([...entries.map((e) => e.host), ...hostAddresses.map((h) => h.host)])];
  return names.map((host) => {
    const own = entries.filter((e) => e.host === host);
    const naming = namingServices.map((s) => own.find((e) => e.service === s)).find(Boolean);
    const model = own.map((e) => e.model).find(Boolean);
    // Grouped by host whatever its case; named as the device spells it.
    const spelt = own[0]?.spelt ?? hostAddresses.find((h) => h.host === host)?.spelt ?? host;
    return {
      host: labelOf(host),
      name: naming?.friendly ?? naming?.instance ?? labelOf(spelt),
      addresses: [...new Set([...own.flatMap((e) => e.addresses), ...(hostAddresses.find((h) => h.host === host)?.addresses ?? [])])],
      ...(model ? { model } : {}),
      services: [...new Set(own.map((e) => e.service))].sort(),
    };
  });
};
