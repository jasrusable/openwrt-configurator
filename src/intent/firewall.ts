// The firewall, in OpenWrt's own terms: zones (each grouping networks, with
// input/forward/output policies), forwardings between zones, traffic rules,
// port forwards (DNAT), and the stock WAN rules as named built-ins that can be
// switched off. The built-in WAN zone is "wan"; "router" as a rule's
// destination means traffic to the router itself (fw4 input).
import { z } from "zod";

export const policies = ["accept", "reject", "drop"] as const;
const policy = z.enum(policies);

/** A short id: it names the fw4 zone, which allows at most 11 characters. */
export const zoneId = z
  .string()
  .regex(/^[a-z][a-z0-9]{0,9}$/, "a short id")
  .refine((id) => id !== "wan" && id !== "router", "reserved");

/** A port, a range or a list: "443", "8000-8100", "80,443". */
const ports = z
  .string()
  .regex(
    /^\d{1,5}(-\d{1,5})?(,\d{1,5}(-\d{1,5})?)*$/,
    "a port, a range like 8000-8100, or a list like 80,443"
  )
  .refine(
    (value) => value.split(/[,-]/).every((p) => +p >= 1 && +p <= 65535),
    "ports are 1 to 65535"
  );

const address = z
  .string()
  .regex(
    /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$|^[0-9a-f:]+(\/\d{1,3})?$/i,
    "an IP address or a range like 10.0.0.0/24"
  );

export const protocols = ["tcp+udp", "tcp", "udp", "icmp", "any"] as const;

export const zoneSchema = z
  .object({
    id: zoneId,
    /** Unset: the zone is known by its networks' names (zoneLabel). */
    name: z.string().max(32).optional(),
    /** The network ids in this zone. */
    networks: z.array(z.string()),
    /** Traffic to the router itself. */
    input: policy,
    /** Traffic between this zone's own networks. */
    forward: policy,
    output: policy,
    /** Answer DHCP, DNS and NTP even when input is not accept. */
    router_services: z.boolean().default(true),
  })
  .strict();

export const forwardingSchema = z
  .object({
    /** A zone id, or "wan". */
    from: z.string(),
    to: z.string(),
  })
  .strict();

export const ruleSchema = z
  .object({
    name: z.string().min(1, "required").max(64),
    enabled: z.boolean().default(true),
    /** A zone id, or "wan". */
    from: z.string(),
    /** A zone id, "wan", or "router" for traffic to the router itself. */
    to: z.string(),
    source_addresses: z.array(address).optional(),
    destination_addresses: z.array(address).optional(),
    protocol: z.enum(protocols),
    ports: ports.optional(),
    family: z.enum(["any", "ipv4", "ipv6"]).default("any"),
    action: policy,
  })
  .strict();

export const portForwardSchema = z
  .object({
    name: z.string().min(1, "required").max(64),
    enabled: z.boolean().default(true),
    protocol: z.enum(["tcp+udp", "tcp", "udp"]),
    external_port: ports,
    /** A host on one of the networks. */
    internal_address: z
      .string()
      .regex(/^(\d{1,3}\.){3}\d{1,3}$/, "an IPv4 address on one of your networks"),
    /** Defaults to the external port. */
    internal_port: ports.optional(),
    /** Only from these addresses, if set. */
    source_addresses: z.array(address).optional(),
    /** Also reachable from inside, by the public address (NAT loopback). */
    reflection: z.boolean().default(true),
  })
  .strict();

/**
 * OpenWrt's stock WAN rules, by id: on unless switched off. The IPv6 ones
 * keep IPv6 working; the rest are conveniences.
 */
export const builtinRules = {
  dhcp_renew: {
    label: "Allow DHCP renewal",
    description: "Lets the router renew its address from your ISP.",
    rules: () => [
      { name: "Allow-DHCP-Renew", src: "wan", proto: ["udp"], dest_port: [68], target: "ACCEPT", family: "ipv4" },
    ],
  },
  ping: {
    label: "Allow ping",
    description: "Answer pings from the internet.",
    rules: () => [
      { name: "Allow-Ping", src: "wan", proto: ["icmp"], icmp_type: ["echo-request"], family: "ipv4", target: "ACCEPT" },
    ],
  },
  igmp: {
    label: "Allow IGMP",
    description: "Multicast from the ISP, e.g. for IPTV.",
    rules: () => [
      { name: "Allow-IGMP", src: "wan", proto: ["igmp"], family: "ipv4", target: "ACCEPT" },
    ],
  },
  ipv6: {
    label: "IPv6 essentials",
    description: "DHCPv6, MLD and ICMPv6 from the ISP. IPv6 does not work without them.",
    rules: () => [
      { name: "Allow-DHCPv6", src: "wan", proto: ["udp"], dest_port: [546], family: "ipv6", target: "ACCEPT" },
      { name: "Allow-MLD", src: "wan", proto: ["icmp"], src_ip: ["fe80::/10"], icmp_type: ["130/0", "131/0", "132/0", "143/0"], family: "ipv6", target: "ACCEPT" },
      { name: "Allow-ICMPv6-Input", src: "wan", proto: ["icmp"], icmp_type: ["echo-request", "echo-reply", "destination-unreachable", "packet-too-big", "time-exceeded", "bad-header", "unknown-header-type", "router-solicitation", "neighbour-solicitation", "router-advertisement", "neighbour-advertisement"], limit: "1000/sec", family: "ipv6", target: "ACCEPT" },
      { name: "Allow-ICMPv6-Forward", src: "wan", dest: "*", proto: ["icmp"], icmp_type: ["echo-request", "echo-reply", "destination-unreachable", "packet-too-big", "time-exceeded", "bad-header", "unknown-header-type"], limit: "1000/sec", family: "ipv6", target: "ACCEPT" },
    ],
  },
  ipsec_passthrough: {
    label: "IPsec passthrough",
    description: "Lets IPsec VPNs from the internet reach the main zone.",
    rules: (mainZone: string) => [
      { name: "Allow-IPSec-ESP", src: "wan", dest: mainZone, proto: ["esp"], target: "ACCEPT" },
      { name: "Allow-ISAKMP", src: "wan", dest: mainZone, dest_port: [500], proto: ["udp"], target: "ACCEPT" },
    ],
  },
} as const;

export type BuiltinRule = keyof typeof builtinRules;

export const firewallSchema = z
  .object({
    defaults: z
      .object({
        input: policy.default("reject"),
        output: policy.default("accept"),
        forward: policy.default("reject"),
        syn_flood_protection: z.boolean().default(true),
        drop_invalid: z.boolean().default(true),
      })
      .strict()
      .default({}),
    zones: z.array(zoneSchema),
    forwardings: z.array(forwardingSchema).default([]),
    rules: z.array(ruleSchema).default([]),
    port_forwards: z.array(portForwardSchema).default([]),
    /** Stock rules switched off; every other one is on. */
    builtin_rules_off: z
      .array(z.enum(Object.keys(builtinRules) as [BuiltinRule, ...BuiltinRule[]]))
      .default([]),
  })
  .strict();

export type Firewall = z.infer<typeof firewallSchema>;

/** What to call a zone: its name, or else its networks'. */
export const zoneLabel = (zone: { id: string; name?: string; networks: string[] }, networks: { id: string; name: string }[]) =>
  zone.name ||
  zone.networks
    .map((id) => networks.find((n) => n.id === id)?.name)
    .filter(Boolean)
    .join(" + ") ||
  zone.id;
export type Zone = z.infer<typeof zoneSchema>;

/**
 * A new network's zone and forwardings, from its purpose: the starting point,
 * which the firewall then owns. Home is trusted (the router and every other
 * zone); guest and IoT reach only the internet, plus the router's services.
 */
export const zoneForPurpose = (
  purpose: "home" | "guest" | "iot",
  {
    id,
    network,
    otherZones,
  }: { id: string; network: string; otherZones: string[] }
): { zone: Zone; forwardings: { from: string; to: string }[] } => {
  const trusted = purpose === "home";
  return {
    zone: {
      id,
      networks: [network],
      input: trusted ? "accept" : "reject",
      forward: trusted ? "accept" : "reject",
      output: "accept",
      router_services: true,
    },
    forwardings: [
      { from: id, to: "wan" },
      ...(trusted ? otherZones.map((to) => ({ from: id, to })) : []),
    ],
  };
};
