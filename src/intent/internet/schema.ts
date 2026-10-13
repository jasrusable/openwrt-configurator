// The ways out: internet lines on the router's ports, how several are used,
// opening ports (UPnP) and a name that follows the address (dynamic DNS).
import { z } from "zod";
import { dnsServer, ipv4 } from "../validators";

/**
 * Smart queueing's per-packet overhead, by the kind of line: what the line
 * adds to every packet, from OpenWrt's SQM guidance. Too much only costs a
 * little speed; too little lets the modem's queue fill, which is the lag
 * queueing is there to prevent.
 */
export const lineTypes = ["fibre", "cable", "vdsl", "adsl"] as const;

/** How much IPv6 space to ask the provider for: each network takes a /64. */
export const ipv6Prefixes = ["auto", "48", "56", "60", "64"] as const;

export const internetModes = ["failover", "balance"] as const;

export const ddnsProviders = ["cloudflare", "duckdns", "dynv6"] as const;

/** What every line has, whatever its type. */
const lineBase = {
  /** Hidden and stable: it names the line's interfaces (wan and wan6; wanb and wanb6). */
  id: z.string().regex(/^wan[b-z]?$/, "an id like wan or wanb"),
  name: z.string().min(1, "required").max(32, "at most 32 characters"),
  /** The router port it plugs into; unset, the one the router's maker marked WAN. */
  port: z
    .string()
    .regex(/^[A-Za-z0-9._-]+$/, "a port name, like eth2")
    .optional(),
  /** The provider's VLAN, for a line that must be tagged. */
  vlan: z.number().int().min(1, "1 to 4094").max(4094, "1 to 4094").optional(),
  /** The first line's: the networks' IPv6 comes from it. */
  ipv6: z
    .object({
      enabled: z.boolean().default(true),
      /** How much to ask the provider for: each network takes a /64. */
      prefix: z.enum(ipv6Prefixes).default("auto"),
    })
    .strict()
    .default({}),
  /** Smart queueing (less lag under load), on when the line's speeds are set. */
  shaping: z
    .object({
      down_mbps: z.number().positive(),
      up_mbps: z.number().positive(),
      /** What carries it: the per-packet overhead queueing counts. */
      medium: z.enum(lineTypes).default("fibre"),
    })
    .strict()
    .optional(),
  /** With several lines. */
  failover: z
    .object({
      /** Sharing traffic: its share of new connections, against the others'. */
      weight: z.number().int().min(1, "1 to 100").max(100, "1 to 100").default(1),
      /** Paid by the amount (LTE): checked sparingly, and only a backup, never shared. */
      metered: z.boolean().default(false),
      /** A line that is up but too slow to use counts as down. */
      down_when_slow: z.boolean().default(false),
    })
    .strict()
    .default({}),
};

/** One way to the internet: a line on a port of the router, and how it connects. */
const internetLine = z.discriminatedUnion("type", [
  z.object({ ...lineBase, type: z.literal("dhcp") }).strict(),
  z
    .object({
      ...lineBase,
      type: z.literal("pppoe"),
      pppoe: z
        .object({
          username: z.string().min(1, "required"),
          password: z.string().min(1, "required"),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...lineBase,
      type: z.literal("static"),
      static: z
        .object({
          address: ipv4,
          prefix_length: z.number().int().min(8).max(30),
          gateway: ipv4,
          /** Needed while DNS is the provider's (dns.upstream): there is none to learn from it. */
          dns: z.array(dnsServer).optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const internetSchema = z
  .object({
    /**
     * The ways out, in order: the first is the main one, and gives the
     * networks their IPv6; with more, `use_lines` says how they are used.
     */
    lines: z.array(internetLine).min(1, "at least one line"),
    /** With two or more lines. */
    use_lines: z
      .object({
        /** The next takes over when one fails, or they share traffic by weight. */
        mode: z.enum(internetModes).default("failover"),
        /** Sharing traffic: each device keeps to one line (not only for secure websites). */
        sticky_per_device: z.boolean().default(false),
      })
      .strict()
      .default({}),
    /** Devices on the main network may open ports for themselves (UPnP, NAT-PMP). */
    upnp: z.boolean().default(false),
    /** A name that follows the internet address (dynamic DNS), for remote access and sites. */
    dynamic_dns: z
      .object({
        provider: z.enum(ddnsProviders),
        hostname: z.string().regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, "like home.example.com"),
        /** The provider's API token. */
        token: z.string().min(1, "required"),
        /** Cloudflare: the zone the name is in; unset, its last two labels (example.com). */
        zone: z.string().regex(/^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, "like example.com").optional(),
      })
      .strict()
      .refine((d) => !d.zone || d.hostname === d.zone || d.hostname.endsWith(`.${d.zone}`), {
        message: "the name must be in the zone",
        path: ["zone"],
      })
      .optional(),
  })
  .strict();
