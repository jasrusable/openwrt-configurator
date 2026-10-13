// The firewall, in a home network's terms. Who may reach what is a property
// of each network (its `access`, in schema.ts); the compiler derives fw4's
// zones, policies and forwardings from it, and adds OpenWrt's stock rules
// (features/firewall.ts). What is left to say here is the exceptions: your
// own rules, and port forwards from the internet to a device.
import { z } from "zod";
import { isAddressOrRange, isPortRange, parseIpv4 } from "./addresses";

export { isIpv6 } from "./addresses";

/** A port or a range: "443", "8000-8100". */
const port = z.string().refine(isPortRange, "a port (1 to 65535) or a range like 8000-8100");

/** For rules, several too: "80 443", "80, 443". */
const ports = z
  .string()
  .refine(
    (value) => value.trim().split(/\s*[\s,]\s*/).every(isPortRange),
    "ports 1 to 65535: one, a range like 8000-8100, or several like 80 443"
  );

/**
 * Several ports as fw4 takes them: separated by spaces only. A comma makes it
 * call the value invalid and skip the whole rule (verified on 25.12.5), so a
 * block rule would block nothing.
 */
export const fw4Ports = (value: string) => value.trim().split(/[\s,]+/).join(" ");

const address = z.string().refine(isAddressOrRange, "an IP address or a range like 10.0.0.0/24");

/** Where a rule's traffic comes from: a network's id, the internet, or anywhere. */
export const internet = "internet";
export const anywhere = "*";
/** A rule's destination may also be the router itself. */
export const router = "router";
/** The zones remote access ("vpn") and linked sites ("sites") add: targets of an access, like networks. */
export const remoteAccessZone = "vpn";
export const sitesZone = "sites";
export const vpnZoneIds = [remoteAccessZone, sitesZone];
/** Not usable as a network id: rules use them. */
export const reservedIds = [internet, router, "wan"];

export const ruleProtocols = ["tcp+udp", "tcp", "udp", "icmp", "any"] as const;

/** Ports only mean something for TCP and UDP. */
export const portsApply = (protocol: string | undefined) =>
  ["tcp+udp", "tcp", "udp"].includes(protocol ?? "tcp+udp");

export const ruleSchema = z
  .object({
    name: z.string().min(1, "required").max(64),
    enabled: z.boolean().default(true),
    /** A network id, "internet", or "*". */
    from: z.string(),
    /** A network id, "router", "internet", or "*". */
    to: z.string(),
    /** Only from these devices or ranges; their IP version sets the rule's. */
    from_addresses: z.array(address).optional(),
    /** Only to these devices or ranges. */
    to_addresses: z.array(address).optional(),
    protocol: z.enum(ruleProtocols).default("tcp+udp"),
    /** The ports it goes to, for TCP and UDP. */
    ports: ports.optional(),
    action: z.enum(["allow", "block"]),
  })
  .strict();

export const portForwardSchema = z
  .object({
    name: z.string().min(1, "required").max(64),
    enabled: z.boolean().default(true),
    protocol: z.enum(["tcp+udp", "tcp", "udp"]),
    /** The port (or range) on the internet side. */
    port,
    /** The device it goes to, and its port there (unset, the same). */
    to: z
      .object({
        address: z.string().refine((a) => parseIpv4(a) !== undefined, "an IPv4 address on one of your networks"),
        port: port.optional(),
      })
      .strict(),
    /** Only from these addresses, if set. */
    from_addresses: z.array(address).optional(),
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
 * A network's: also which way its internet goes, with several lines or a VPN
 * provider: `via` a line's or provider's id, with the others as `fallback`
 * when it is down (never for a provider: its kill switch). Unset, the
 * internet's mode decides.
 */
export const networkAccessSchema = accessSchema
  .extend({
    via: z.string().min(1, "pick a line").optional(),
    fallback: z.boolean().default(true),
  })
  .strict();

