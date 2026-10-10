// The firewall, on the router: fw4 defaults, the WAN zone, the intent's
// zones, forwardings, traffic rules and port forwards (DNAT), the stock WAN
// rules not switched off, and, for zones that do not accept input, the
// router services (DHCP, DNS, NTP, IPv6 neighbour discovery) they need.
import { builtinRules, BuiltinRule, Zone } from "../firewall";
import { Feature, mainNetwork, onRouter } from "../fragment";

const upper = (policy: string) => policy.toUpperCase();

/** fw4's protocol list for a rule; unset in fw4 means tcp+udp. */
const proto = (protocol: string) =>
  protocol === "tcp+udp"
    ? ["tcp", "udp"]
    : protocol === "any"
    ? ["all"]
    : [protocol];

type Section = Record<string, unknown>;

const routerServices = (zone: string): Section[] => [
  { name: `${zone}-DHCP`, src: zone, proto: ["udp"], dest_port: [67], family: "ipv4", target: "ACCEPT" },
  { name: `${zone}-DHCPv6`, src: zone, proto: ["udp"], dest_port: [547], family: "ipv6", target: "ACCEPT" },
  { name: `${zone}-DNS`, src: zone, proto: ["tcp", "udp"], dest_port: [53], target: "ACCEPT" },
  { name: `${zone}-NTP`, src: zone, proto: ["udp"], dest_port: [123], target: "ACCEPT" },
  {
    name: `${zone}-ICMPv6`,
    src: zone,
    proto: ["icmp"],
    icmp_type: ["router-solicitation", "neighbour-solicitation", "neighbour-advertisement", "echo-request"],
    family: "ipv6",
    target: "ACCEPT",
  },
];

export const firewall: Feature = (intent) => {
  const { defaults, zones, forwardings, rules, port_forwards, builtin_rules_off } =
    intent.firewall;
  const { connection, ipv6 } = intent.internet;
  const routerOnly = (sections: Record<string, unknown>[]) =>
    sections.map((section) => ({ ".if": onRouter, ...section }));
  const zoneOf = (networkId: string) =>
    zones.find((z) => z.networks.includes(networkId));
  const mainZone = zoneOf(mainNetwork(intent).id)!.id;
  // The zone holding the network an address is on (port forward targets).
  const zoneOfAddress = (address: string) => {
    const prefix = address.split(".").slice(0, 3).join(".");
    const network = intent.networks.find((n) => n.subnet.startsWith(`${prefix}.`));
    return network && zoneOf(network.id)?.id;
  };

  return {
    config: {
      firewall: {
        defaults: routerOnly([
          {
            input: upper(defaults.input),
            output: upper(defaults.output),
            forward: upper(defaults.forward),
            synflood_protect: defaults.syn_flood_protection,
            drop_invalid: defaults.drop_invalid,
          },
        ]),
        zone: routerOnly([
          {
            name: "wan",
            input: "REJECT",
            output: "ACCEPT",
            forward: "DROP",
            masq: true,
            mtu_fix: true,
            network: ipv6 && connection.type === "dhcp" ? ["wan", "wan6"] : ["wan"],
          },
          ...zones.map((zone: Zone) => ({
            name: zone.id,
            input: upper(zone.input),
            output: upper(zone.output),
            forward: upper(zone.forward),
            network: zone.networks,
          })),
        ]),
        forwarding: routerOnly(forwardings.map((f) => ({ src: f.from, dest: f.to }))),
        rule: routerOnly([
          ...(Object.keys(builtinRules) as BuiltinRule[])
            .filter((id) => !builtin_rules_off.includes(id))
            .flatMap((id): Section[] => [...builtinRules[id].rules(mainZone)]),
          ...zones
            .filter((zone) => zone.router_services && zone.input !== "accept")
            .flatMap((zone) => routerServices(zone.id)),
          ...rules.map((rule): Section => ({
            name: rule.name,
            ...(rule.enabled ? {} : { enabled: false }),
            src: rule.from,
            ...(rule.to === "router" ? {} : { dest: rule.to }),
            ...(rule.source_addresses?.length ? { src_ip: rule.source_addresses } : {}),
            ...(rule.destination_addresses?.length
              ? { dest_ip: rule.destination_addresses }
              : {}),
            proto: proto(rule.protocol),
            ...(rule.ports ? { dest_port: rule.ports } : {}),
            family: rule.family,
            target: upper(rule.action),
          })),
        ]),
        redirect: routerOnly(
          port_forwards.map((forward) => ({
            name: forward.name,
            ...(forward.enabled ? {} : { enabled: false }),
            target: "DNAT",
            src: "wan",
            src_dport: forward.external_port,
            proto: proto(forward.protocol),
            ...(forward.source_addresses?.length
              ? { src_ip: forward.source_addresses }
              : {}),
            dest: zoneOfAddress(forward.internal_address),
            dest_ip: forward.internal_address,
            dest_port: forward.internal_port ?? forward.external_port,
            family: "ipv4",
            reflection: forward.reflection,
          }))
        ),
      },
    },
  };
};
