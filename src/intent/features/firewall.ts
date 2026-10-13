// The firewall, on the router, derived for fw4: a zone per network (its
// policy from the network's router access) plus WAN, forwardings from each
// network's access, OpenWrt's stock rules, the router's services for
// networks that get only those, then the user's rules in their order, and
// port forwards (DNAT) into the zone of their target's network.
import { portsApply } from "../choices";
import { anywhere, fw4Ports, internet, isIpv6, router, Rule } from "../firewall";
import { ipv6Interface } from "../connections";
import { Feature, onRouter } from "../fragment";
import { named } from "../names";

type Section = Record<string, unknown>;

/** fw4's zone for the internet side. */
const wan = "wan";

/** OpenWrt's stock rules, as a fresh install has them: always on. */
const stockRules = (mainZone: string): Section[] => {
  const icmpv6 = [
    "echo-request",
    "echo-reply",
    "destination-unreachable",
    "packet-too-big",
    "time-exceeded",
    "bad-header",
    "unknown-header-type",
  ];
  return [
    { name: "Allow-DHCP-Renew", src: wan, proto: ["udp"], dest_port: "68", family: "ipv4", target: "ACCEPT" },
    { name: "Allow-Ping", src: wan, proto: ["icmp"], icmp_type: ["echo-request"], family: "ipv4", target: "ACCEPT" },
    { name: "Allow-IGMP", src: wan, proto: ["igmp"], family: "ipv4", target: "ACCEPT" },
    { name: "Allow-DHCPv6", src: wan, proto: ["udp"], dest_port: "546", family: "ipv6", target: "ACCEPT" },
    { name: "Allow-MLD", src: wan, proto: ["icmp"], src_ip: ["fe80::/10"], icmp_type: ["130/0", "131/0", "132/0", "143/0"], family: "ipv6", target: "ACCEPT" },
    {
      name: "Allow-ICMPv6-Input",
      src: wan,
      proto: ["icmp"],
      icmp_type: [...icmpv6, "router-solicitation", "neighbour-solicitation", "router-advertisement", "neighbour-advertisement"],
      limit: "1000/sec",
      family: "ipv6",
      target: "ACCEPT",
    },
    { name: "Allow-ICMPv6-Forward", src: wan, dest: "*", proto: ["icmp"], icmp_type: icmpv6, limit: "1000/sec", family: "ipv6", target: "ACCEPT" },
    { name: "Allow-IPSec-ESP", src: wan, dest: mainZone, proto: ["esp"], target: "ACCEPT" },
    { name: "Allow-ISAKMP", src: wan, dest: mainZone, proto: ["udp"], dest_port: "500", target: "ACCEPT" },
  ];
};

/**
 * What a network that may not use the router otherwise needs from it to
 * work at all: addresses, names, time and IPv6 neighbour discovery.
 */
const serviceRules = (zone: string): Section[] => [
  { name: `Allow-${zone}-DHCP`, src: zone, proto: ["udp"], dest_port: "67", family: "ipv4", target: "ACCEPT" },
  { name: `Allow-${zone}-DHCPv6`, src: zone, proto: ["udp"], dest_port: "547", family: "ipv6", target: "ACCEPT" },
  { name: `Allow-${zone}-DNS`, src: zone, proto: ["tcp", "udp"], dest_port: "53", target: "ACCEPT" },
  { name: `Allow-${zone}-NTP`, src: zone, proto: ["udp"], dest_port: "123", target: "ACCEPT" },
  {
    name: `Allow-${zone}-ICMPv6`,
    src: zone,
    proto: ["icmp"],
    icmp_type: ["router-solicitation", "neighbour-solicitation", "neighbour-advertisement", "echo-request"],
    family: "ipv6",
    target: "ACCEPT",
  },
];

/** A rule's end as an fw4 zone: the internet is WAN; "router" has none. */
const zoneOf = (end: string) => (end === internet ? wan : end);

const userRule = (rule: Rule): Section => {
  const addresses = [...(rule.source_addresses ?? []), ...(rule.destination_addresses ?? [])];
  const family = addresses.length === 0 ? undefined : isIpv6(addresses[0]) ? "ipv6" : "ipv4";
  const protocol = rule.protocol ?? "tcp+udp";
  return {
    name: rule.name,
    ...(rule.enabled === false ? { enabled: false } : {}),
    src: zoneOf(rule.from),
    // To the router is fw4's input: a rule with no destination zone.
    ...(rule.to === router ? {} : { dest: rule.to === anywhere ? "*" : zoneOf(rule.to) }),
    ...(rule.source_addresses?.length ? { src_ip: rule.source_addresses } : {}),
    ...(rule.destination_addresses?.length ? { dest_ip: rule.destination_addresses } : {}),
    // Kept in the intent for when the protocol is TCP or UDP again.
    ...(rule.destination_port && portsApply(protocol) ? { dest_port: fw4Ports(rule.destination_port) } : {}),
    proto: protocol === "tcp+udp" ? ["tcp", "udp"] : protocol === "any" ? ["all"] : [protocol],
    ...(family ? { family } : {}),
    // Blocked from the internet: dropped, so a scan learns nothing. From
    // inside: rejected, so the device gives up at once instead of waiting.
    target: rule.action === "allow" ? "ACCEPT" : rule.from === internet ? "DROP" : "REJECT",
  };
};

export const firewall: Feature = (intent) => {
  const { rules, port_forwards } = intent.firewall;
  const { networks } = intent;
  const routerOnly = (sections: Section[]) =>
    sections.map((section) => ({ ".if": onRouter, ...section }));
  const main = networks.find((n) => n.vlan === undefined) ?? networks[0];
  // The interfaces the internet connection makes (features/internet.ts).
  const wanInterfaces = intent.internet.connections.flatMap((c, i) =>
    i === 0 && c.ipv6 ? [c.id, ipv6Interface(c)] : [c.id]
  );
  // What has a zone and an access: each network, and remote access's clients
  // and the linked sites when there are any, which networks may reach in turn.
  const areas = [
    ...networks.map((n) => ({ id: n.id, access: n.access })),
    ...(intent.vpn.enabled ? [{ id: "vpn", access: intent.vpn.access }] : []),
    ...(intent.sites.peers.length ? [{ id: "sites", access: intent.sites.access }] : []),
  ];
  // Networks out through a provider's tunnel (their Internet line).
  // Only a network with internet access: the tunnel is a way to the internet.
  const viaTunnel = networks.flatMap((n) => {
    const tunnel = intent.tunnels.find((t) => t.id === n.line?.connection);
    return tunnel && n.access.internet ? [{ network: n, tunnel }] : [];
  });
  // The network an address is on: where a port forward lands.
  const networkOf = (address: string) => {
    const prefix = address.split(".").slice(0, 3).join(".");
    return networks.find((n) => n.subnet.startsWith(`${prefix}.`))?.id;
  };

  return {
    // fw4 loads its rules and exits: enabled, with nothing left running.
    services: [{ ".if": onRouter, name: "firewall" }],
    config: {
      firewall: {
        defaults: routerOnly([
          {
            input: "REJECT",
            output: "ACCEPT",
            forward: "REJECT",
            synflood_protect: true,
            drop_invalid: true,
          },
        ]),
        zone: routerOnly([
          // Each network its own zone, named by its id. Between networks only
          // what forwardings allow; to the router as its access says. Section
          // names are the zone's, so adding or reordering networks never
          // renames another zone (the apply diff would show it all changing).
          ...areas.map((area) => ({
            ".name": area.id,
            name: area.id,
            input: area.access.router === "full" ? "ACCEPT" : "REJECT",
            output: "ACCEPT",
            forward: "REJECT",
            network: [area.id],
          })),
          // A provider's tunnel: out like the internet, masqueraded.
          ...intent.tunnels.map((tunnel) => ({
            ".name": tunnel.id,
            name: tunnel.id,
            input: "REJECT",
            output: "ACCEPT",
            forward: "REJECT",
            masq: true,
            mtu_fix: true,
            network: [tunnel.id],
          })),
          {
            ".name": wan,
            name: wan,
            input: "REJECT",
            output: "ACCEPT",
            forward: "REJECT",
            masq: true,
            mtu_fix: true,
            network: wanInterfaces,
          },
        ]),
        forwarding: routerOnly([
          ...areas.flatMap((area) => [
            ...(area.access.internet ? [{ ".name": `${area.id}_${wan}`, src: area.id, dest: wan }] : []),
            // Access to remote access or sites while they are off is kept, not compiled.
            ...area.access.networks
              .filter((to) => areas.some((a) => a.id === to))
              .map((to) => ({ ".name": `${area.id}_${to}`, src: area.id, dest: to })),
          ]),
          ...viaTunnel.map(({ network, tunnel }) => ({ ".name": `${network.id}_${tunnel.id}`, src: network.id, dest: tunnel.id })),
        ]),
        // Named by their names: order still matters to fw4, but inserting
        // one renames no other. The user's own come first: fw4 stops at the
        // first match, so after the stock allows a block of ping from the
        // internet, or of a guest's DNS, would never be reached.
        rule: routerOnly(named("rule", [
          ...rules.map(userRule),
          ...stockRules(main.id),
          ...areas.filter((a) => a.access.router === "services").flatMap((a) => serviceRules(a.id)),
          // WireGuard from the internet: remote access's clients, the sites.
          ...(intent.vpn.enabled
            ? [{ name: "Allow-WireGuard", src: wan, proto: ["udp"], dest_port: String(intent.vpn.port), target: "ACCEPT" }]
            : []),
          ...(intent.sites.peers.length
            ? [{ name: "Allow-WireGuard-sites", src: wan, proto: ["udp"], dest_port: String(intent.sites.port), target: "ACCEPT" }]
            : []),
          // Sharing devices: the router's reflector must hear the network's mDNS.
          ...networks
            .filter((n) => n.share_devices && n.access.router === "services")
            .map((n) => ({
              name: `Allow-${n.id}-mDNS`,
              src: n.id,
              proto: ["udp"],
              dest_port: "5353",
              target: "ACCEPT",
            })),
        ], (r) => String(r.name))),
        redirect: routerOnly(
          named(
            "redirect",
            port_forwards.map((forward) => ({
              name: forward.name,
              ...(forward.enabled ? {} : { enabled: false }),
              target: "DNAT",
              src: wan,
              src_dport: forward.external_port,
              proto: forward.protocol === "tcp+udp" ? ["tcp", "udp"] : [forward.protocol],
              ...(forward.source_addresses?.length ? { src_ip: forward.source_addresses } : {}),
              dest: networkOf(forward.internal_address),
              dest_ip: forward.internal_address,
              dest_port: forward.internal_port ?? forward.external_port,
              family: "ipv4",
              reflection: forward.reflection,
            })),
            (f) => String(f.name)
          )
        ),
      },
    },
  };
};
