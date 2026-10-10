// The intent file: what the network should be, in the user's terms. It holds
// decisions only, never device facts (models, ports, radios, versions), which
// are read from the devices when they are provisioned. The UI edits this file
// and nothing else; src/intent/compile.ts turns it into the low-level config.
import { z } from "zod";
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

const ipv4Subnet = z
  .string()
  .regex(
    /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/24$/,
    "an IPv4 /24, like 10.0.0.0/24"
  );

export const intentSchema = z
  .object({
    /** This file's format version, for migrations. */
    schema: z.literal(1),

    site: z
      .object({
        name: z.string().min(1),
        timezone: z
          .string()
          .refine((zone) => zone in timezones, "an IANA zone, like Europe/Zurich"),
        /** Wi-Fi regulatory domain, ISO 3166 (CH, US, ...). */
        country: z.string().regex(/^[A-Z]{2}$/, "two capital letters"),
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

    /** The home network. One for now; guest and IoT networks come later. */
    network: z
      .object({
        subnet: ipv4Subnet,
        /** Devices are reachable as <name>.<domain>. */
        domain: name.default("lan"),
        dhcp: z
          .object({
            size: z.number().int().min(1).max(253),
            lease: z.string().regex(/^\d+[mhd]$/, "like 12h, 30m or 7d"),
          })
          .strict()
          .default({ size: 150, lease: "12h" }),
        ipv6: z.boolean().default(true),
      })
      .strict(),

    wifi: z.array(
      z
        .object({
          ssid: z.string().min(1).max(32),
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
      })
      .strict()
      .default({}),
  })
  .strict();

export type Intent = z.infer<typeof intentSchema>;
/** What a file or the UI supplies: defaults not yet applied. */
export type IntentInput = z.input<typeof intentSchema>;
