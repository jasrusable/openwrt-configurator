// The firewall, as OpenWrt (fw4) and LuCI have it: defaults; zones, WAN
// among them, each covering networks with input/output/forward policies,
// masquerading and MSS clamping; forwardings between zones; traffic rules,
// OpenWrt's stock ones included, as ordinary rules; and port forwards. A
// rule's destination may be a zone, "router" (LuCI's "Device (input)") or
// "*" (any zone); its source a zone or "*".
import { z } from "zod";

export const policies = ["accept", "reject", "drop"] as const;
const policy = z.enum(policies);

/** The WAN zone's id: it covers the internet connection, not a network. */
export const wanZone = "wan";

/** A short id: it names the fw4 zone, which allows at most 11 characters. */
export const zoneId = z
  .string()
  .regex(/^[a-z][a-z0-9]{0,9}$/, "a short id")
  .refine((id) => id !== "router", "reserved");

/** A port or a range: "443", "8000-8100". */
const port = z
  .string()
  .regex(/^\d{1,5}(-\d{1,5})?$/, "a port or a range like 8000-8100")
  .refine((value) => value.split("-").every((p) => +p >= 1 && +p <= 65535), "ports are 1 to 65535");

/** For rules, several too: "80 443". */
const ports = z
  .string()
  .regex(
    /^\d{1,5}(-\d{1,5})?([ ,]\d{1,5}(-\d{1,5})?)*$/,
    "a port, a range like 8000-8100, or several like 80 443"
  )
  .refine(
    (value) => value.split(/[ ,-]/).every((p) => +p >= 1 && +p <= 65535),
    "ports are 1 to 65535"
  );

const address = z
  .string()
  .regex(
    /^!?((\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?|[0-9a-f:]+(\/\d{1,3})?)$/i,
    "an IP address or a range like 10.0.0.0/24"
  );

export const protocols = ["tcp", "udp", "icmp", "igmp", "esp", "ah", "sctp", "all"] as const;

export const icmpTypes = [
  "echo-request",
  "echo-reply",
  "destination-unreachable",
  "packet-too-big",
  "time-exceeded",
  "bad-header",
  "unknown-header-type",
  "router-solicitation",
  "neighbour-solicitation",
  "router-advertisement",
  "neighbour-advertisement",
  "130/0",
  "131/0",
  "132/0",
  "143/0",
] as const;

export const zoneSchema = z
  .object({
    id: zoneId,
    /** Unset: the zone is known by its networks' names (zoneLabel). */
    name: z.string().max(32).optional(),
    /** The network ids it covers. The WAN zone covers the internet connection. */
    networks: z.array(z.string()),
    input: policy,
    output: policy,
    /** Between this zone's own networks. */
    forward: policy,
    masquerade: z.boolean().default(false),
    mss_clamping: z.boolean().default(false),
  })
  .strict();

export const forwardingSchema = z
  .object({ from: z.string(), to: z.string() })
  .strict();

export const ruleSchema = z
  .object({
    name: z.string().min(1, "required").max(64),
    enabled: z.boolean().default(true),
    family: z.enum(["any", "ipv4", "ipv6"]).default("any"),
    protocols: z.array(z.enum(protocols)).min(1, "at least one").default(["tcp", "udp"]),
    /** A zone id, or "*" for any zone. */
    from: z.string(),
    source_addresses: z.array(address).optional(),
    source_port: ports.optional(),
    /** A zone id, "router" (to the router itself), or "*" (any zone). */
    to: z.string(),
    destination_addresses: z.array(address).optional(),
    destination_port: ports.optional(),
    icmp_types: z.array(z.enum(icmpTypes)).optional(),
    /** Rate limit, like "1000/sec". */
    limit: z
      .string()
      .regex(/^\d+\/(sec|second|min|minute|hour|day)$/, "like 1000/sec")
      .optional(),
    action: policy,
  })
  .strict();

export const portForwardSchema = z
  .object({
    name: z.string().min(1, "required").max(64),
    enabled: z.boolean().default(true),
    protocol: z.enum(["tcp+udp", "tcp", "udp"]),
    external_port: port,
    /** A host on one of the networks. */
    internal_address: z
      .string()
      .regex(/^(\d{1,3}\.){3}\d{1,3}$/, "an IPv4 address on one of your networks"),
    /** Defaults to the external port. */
    internal_port: port.optional(),
    /** Only from these addresses, if set. */
    source_addresses: z.array(address).optional(),
    /** Also reachable from inside, by the public address (NAT loopback). */
    reflection: z.boolean().default(true),
  })
  .strict();

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
  })
  .strict();

export type Firewall = z.infer<typeof firewallSchema>;
export type Zone = z.infer<typeof zoneSchema>;
export type Rule = z.input<typeof ruleSchema>;

/** What to call a zone: its name, or its networks', or its id. */
export const zoneLabel = (
  zone: { id: string; name?: string; networks: string[] },
  networks: { id: string; name: string }[]
) =>
  zone.name ||
  (zone.id === wanZone ? "WAN" : "") ||
  zone.networks
    .map((id) => networks.find((n) => n.id === id)?.name)
    .filter(Boolean)
    .join(" + ") ||
  zone.id;

/** OpenWrt's WAN zone, as a fresh install has it. */
export const defaultWanZone: Zone = {
  id: wanZone,
  networks: [],
  input: "reject",
  output: "accept",
  forward: "reject",
  masquerade: true,
  mss_clamping: true,
};

/** OpenWrt's stock WAN rules, as a fresh install has them. */
export const stockRules = (mainZone: string): Rule[] => [
  { name: "Allow-DHCP-Renew", from: "wan", to: "router", protocols: ["udp"], destination_port: "68", family: "ipv4", action: "accept" },
  { name: "Allow-Ping", from: "wan", to: "router", protocols: ["icmp"], icmp_types: ["echo-request"], family: "ipv4", action: "accept" },
  { name: "Allow-IGMP", from: "wan", to: "router", protocols: ["igmp"], family: "ipv4", action: "accept" },
  { name: "Allow-DHCPv6", from: "wan", to: "router", protocols: ["udp"], destination_port: "546", family: "ipv6", action: "accept" },
  { name: "Allow-MLD", from: "wan", to: "router", protocols: ["icmp"], source_addresses: ["fe80::/10"], icmp_types: ["130/0", "131/0", "132/0", "143/0"], family: "ipv6", action: "accept" },
  { name: "Allow-ICMPv6-Input", from: "wan", to: "router", protocols: ["icmp"], icmp_types: ["echo-request", "echo-reply", "destination-unreachable", "packet-too-big", "time-exceeded", "bad-header", "unknown-header-type", "router-solicitation", "neighbour-solicitation", "router-advertisement", "neighbour-advertisement"], limit: "1000/sec", family: "ipv6", action: "accept" },
  { name: "Allow-ICMPv6-Forward", from: "wan", to: "*", protocols: ["icmp"], icmp_types: ["echo-request", "echo-reply", "destination-unreachable", "packet-too-big", "time-exceeded", "bad-header", "unknown-header-type"], limit: "1000/sec", family: "ipv6", action: "accept" },
  { name: "Allow-IPSec-ESP", from: "wan", to: mainZone, protocols: ["esp"], action: "accept" },
  { name: "Allow-ISAKMP", from: "wan", to: mainZone, protocols: ["udp"], destination_port: "500", action: "accept" },
];

/**
 * What a zone that rejects input needs from the router to work at all:
 * addresses, names, time and IPv6 neighbour discovery. Ordinary rules, as
 * one would add them in LuCI.
 */
export const routerServiceRules = (zone: string): Rule[] => [
  { name: `Allow-${zone}-DHCP`, from: zone, to: "router", protocols: ["udp"], destination_port: "67", family: "ipv4", action: "accept" },
  { name: `Allow-${zone}-DHCPv6`, from: zone, to: "router", protocols: ["udp"], destination_port: "547", family: "ipv6", action: "accept" },
  { name: `Allow-${zone}-DNS`, from: zone, to: "router", protocols: ["tcp", "udp"], destination_port: "53", action: "accept" },
  { name: `Allow-${zone}-NTP`, from: zone, to: "router", protocols: ["udp"], destination_port: "123", action: "accept" },
  { name: `Allow-${zone}-ICMPv6`, from: zone, to: "router", protocols: ["icmp"], icmp_types: ["router-solicitation", "neighbour-solicitation", "neighbour-advertisement", "echo-request"], family: "ipv6", action: "accept" },
];

/**
 * A new network's zone, forwardings and rules, from its purpose: the starting
 * point, which the firewall then owns. Home is trusted (the router and every
 * other zone); guest and IoT reach only WAN, and get the router's services.
 */
export const zoneForPurpose = (
  purpose: "home" | "guest" | "iot",
  { id, network, otherZones }: { id: string; network: string; otherZones: string[] }
): { zone: Zone; forwardings: { from: string; to: string }[]; rules: Rule[] } => {
  const trusted = purpose === "home";
  return {
    zone: {
      id,
      networks: [network],
      input: trusted ? "accept" : "reject",
      output: "accept",
      forward: trusted ? "accept" : "reject",
      masquerade: false,
      mss_clamping: false,
    },
    forwardings: [
      { from: id, to: wanZone },
      ...(trusted ? otherZones.filter((z) => z !== wanZone).map((to) => ({ from: id, to })) : []),
    ],
    rules: trusted ? [] : routerServiceRules(id),
  };
};
