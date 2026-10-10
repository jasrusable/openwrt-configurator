// The intent file: what the network should be, in the user's terms. It holds
// decisions only, never device facts (models, ports, radios, versions), which
// are read from the devices when they are provisioned. The UI edits this file
// and nothing else; src/intent/compile.ts turns it into the low-level config.
import { z } from "zod";
import { countries } from "./countries";
import { timezones } from "./timezones";

const name = z
  .string()
  .regex(
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/,
    "lowercase letters, digits and -, like a hostname"
  );

const channel = z.union([z.literal("auto"), z.number().int().positive()]);

const wifiPassword = z
  .string()
  .min(8, "at least 8 characters")
  .max(63, "at most 63 characters");

/** A private IPv4 /24 (RFC 1918), like 10.0.0.0/24, as "a.b.c.0/24". */
export const parseSubnet = (subnet: string) => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.0\/24$/.exec(subnet);
  if (!match) return undefined;
  const [a, b, c] = match.slice(1).map(Number);
  const isPrivate =
    a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  return isPrivate && b <= 255 && c <= 255 ? [a, b, c] : undefined;
};

const ipv4Subnet = z
  .string()
  .refine(
    (subnet) => parseSubnet(subnet) !== undefined,
    "a private range: 10.x.x.0/24, 172.16-31.x.0/24 or 192.168.x.0/24"
  );

/** A DHCP lease: a whole number of minutes (at least 2), hours or days. */
const leaseTime = z
  .string()
  .regex(/^\d+[mhd]$/, "like 12h, 30m or 7d")
  .refine(
    (lease) => parseInt(lease, 10) >= (lease.endsWith("m") ? 2 : 1),
    "at least 2 minutes"
  );

export const intentVersion = 2;

export const purposes = ["home", "guest", "iot"] as const;
export type Purpose = (typeof purposes)[number];
export type Access = {
  /** Can reach the internet. */
  internet: boolean;
  /** Can reach devices on the other networks. */
  other_networks: boolean;
  /** Wi-Fi clients cannot reach each other. */
  isolate_clients: boolean;
};

/** What each purpose allows, as a starting point the user can adjust. */
export const purposeAccess: Record<Purpose, Access> = {
  home: { internet: true, other_networks: true, isolate_clients: false },
  guest: { internet: true, other_networks: false, isolate_clients: true },
  iot: { internet: true, other_networks: false, isolate_clients: false },
};

const network = z
  .object({
    /**
     * Stable and hidden: Wi-Fi refers to it, and it names the network on the
     * devices, so renaming never breaks a link. Short, as UCI names must be.
     */
    id: z.string().regex(/^[a-z][a-z0-9]{0,9}$/, "a short id"),
    name: z.string().min(1, "required").max(32),
    purpose: z.enum(purposes),
    access: z
      .object({
        internet: z.boolean(),
        other_networks: z.boolean(),
        isolate_clients: z.boolean(),
      })
      .strict(),
    /** Absent for the main network, which is untagged on every port. */
    vlan: z
      .number()
      .int()
      .min(2, "2 to 4094 (1 is the main network)")
      .max(4094, "2 to 4094")
      .optional(),
    subnet: ipv4Subnet,
    dhcp: z
      .object({
        size: z.number().int().min(1).max(253),
        lease: leaseTime,
      })
      .strict()
      .default({ size: 150, lease: "12h" }),
    ipv6: z.boolean().default(true),
  })
  .strict();

export const intentSchema = z
  .object({
    /** This file's format version; older files are migrated (migrations.ts). */
    schema: z.literal(intentVersion),

    site: z
      .object({
        name: z.string().min(1, "required"),
        timezone: z
          .string()
          .refine((zone) => zone in timezones, "an IANA zone, like Europe/Zurich"),
        /** Wi-Fi regulatory domain, ISO 3166 (CH, US, ...). */
        country: z
          .string()
          .refine((code) => countries.includes(code), "pick a country"),
      })
      .strict(),

    /** How the tool logs in to every device, as root. */
    admin: z
      .object({
        ssh_key_path: z.string().optional(),
        password: z.string().optional(),
      })
      .strict()
      .default({}),

    devices: z
      .array(
        z
          .object({
            name,
            role: z.enum(["router", "access-point"]),
            wifi: z
              .object({
                /** Pin a channel per band; "auto" (the default) lets it choose. */
                channel: z
                  .object({ "2g": channel.optional(), "5g": channel.optional() })
                  .strict()
                  .optional(),
              })
              .strict()
              .optional(),
          })
          .strict()
      )
      .refine(
        (devices) => devices.filter((d) => d.role === "router").length === 1,
        "exactly one device must be the router"
      )
      .refine(
        (devices) => new Set(devices.map((d) => d.name)).size === devices.length,
        "device names must be unique"
      ),

    internet: z
      .object({
        connection: z.discriminatedUnion("type", [
          z.object({ type: z.literal("dhcp") }).strict(),
          z
            .object({
              type: z.literal("pppoe"),
              username: z.string().min(1, "required"),
              password: z.string().min(1, "required"),
            })
            .strict(),
        ]),
        ipv6: z.boolean().default(true),
        /** The line's speed. Set, it turns on smart queueing (less lag under load). */
        speed: z
          .object({
            down_mbps: z.number().positive(),
            up_mbps: z.number().positive(),
          })
          .strict()
          .optional(),
      })
      .strict(),

    /**
     * The networks: one untagged main network, and any number on their own
     * VLANs (guests, IoT). Every LAN port and access point carries them all.
     */
    networks: z.array(network).min(1, "at least one network"),

    wifi: z.array(
      z
        .object({
          ssid: z.string().min(1, "required").max(32, "at most 32 characters"),
          /** The id of the network it joins. */
          network: z.string().min(1, "pick a network"),
          password: wifiPassword,
          /** More passwords for the same network, e.g. one per person. */
          extra_passwords: z.array(wifiPassword).optional(),
        })
        .strict()
    ),

    dns: z
      .object({
        /** Encrypt lookups to this provider. Unset: use the ISP's resolvers. */
        over_https: z.enum(["cloudflare", "google", "quad9"]).optional(),
        /** Devices are reachable as <name>.<local_domain>. */
        local_domain: name.default("lan"),
      })
      .strict()
      .default({}),
  })
  .strict()
  .superRefine((intent, ctx) => {
    // Rules across settings, at the field they concern, so the UI shows them
    // there. The server applies the same ones: nothing invalid is saved.
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    const untagged = intent.networks.filter((n) => n.vlan === undefined);
    if (untagged.length !== 1) {
      issue(["networks"], "exactly one network must be the main, untagged one");
    }
    intent.networks.forEach((network, i) => {
      const earlier = intent.networks.slice(0, i);
      if (earlier.some((n) => n.id === network.id)) {
        issue(["networks", i, "id"], "already used by another network");
      }
      if (network.vlan !== undefined && earlier.some((n) => n.vlan === network.vlan)) {
        issue(["networks", i, "vlan"], "already used by another network");
      }
      if (earlier.some((n) => n.subnet === network.subnet)) {
        issue(["networks", i, "subnet"], "already used by another network");
      }
    });
    const ids = intent.networks.map((n) => n.id);
    intent.wifi.forEach((wifi, i) => {
      if (!ids.includes(wifi.network)) {
        issue(["wifi", i, "network"], "pick a network");
      }
    });
  });

export type Intent = z.infer<typeof intentSchema>;
/** What a file or the UI supplies: defaults not yet applied. */
export type IntentInput = z.input<typeof intentSchema>;
