// The firewall, in a home network's terms. Who may reach what is a property
// of each network (its `access`, in schema.ts); the compiler derives fw4's
// zones, policies and forwardings from it, and adds OpenWrt's stock rules
// (features/firewall.ts). What is left to say here is the exceptions: your
// own rules, and port forwards from the internet to a device.
import { z } from "zod";

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
    /^((\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?|[0-9a-f:]+(\/\d{1,3})?)$/i,
    "an IP address or a range like 10.0.0.0/24"
  );

/** Whether an address (or range) is IPv6. */
export const isIpv6 = (address: string) => address.includes(":");

/** Where a rule's traffic comes from: a network's id, the internet, or anywhere. */
export const internet = "internet";
export const anywhere = "*";
/** A rule's destination may also be the router itself. */
export const router = "router";
/** Not usable as a network id: rules use them. */
export const reservedIds = [internet, router, "wan"];

export const ruleProtocols = ["tcp+udp", "tcp", "udp", "icmp", "any"] as const;

export const ruleSchema = z
  .object({
    name: z.string().min(1, "required").max(64),
    enabled: z.boolean().default(true),
    /** A network id, "internet", or "*". */
    from: z.string(),
    /** A network id, "router", "internet", or "*". */
    to: z.string(),
    /** Only from these devices or ranges; their IP version sets the rule's. */
    source_addresses: z.array(address).optional(),
    /** Only to these devices or ranges. */
    destination_addresses: z.array(address).optional(),
    protocol: z.enum(ruleProtocols).default("tcp+udp"),
    /** For TCP and UDP. */
    destination_port: ports.optional(),
    action: z.enum(["allow", "block"]),
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
    rules: z.array(ruleSchema).default([]),
    port_forwards: z.array(portForwardSchema).default([]),
  })
  .strict()
  .default({});

export type Rule = z.input<typeof ruleSchema>;

/** What a network may reach: the internet, other networks, the router. */
export const accessSchema = z
  .object({
    internet: z.boolean().default(true),
    /** Ids of the networks it may open connections to. Replies always pass. */
    networks: z.array(z.string()).default([]),
    /** "full": anything on the router, its admin included. "services": DHCP, DNS and time only. */
    router: z.enum(["full", "services"]).default("services"),
  })
  .strict();

export type Access = z.infer<typeof accessSchema>;

/**
 * A new network's access, from its purpose: home is trusted (the router and
 * every other network); guests and IoT get the internet and the router's
 * services only. A starting point, edited on the network afterwards.
 */
export const accessForPurpose = (
  purpose: "home" | "guest" | "iot",
  otherNetworks: string[]
): Access =>
  purpose === "home"
    ? { internet: true, networks: otherNetworks, router: "full" }
    : { internet: true, networks: [], router: "services" };
