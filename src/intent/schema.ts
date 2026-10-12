// The intent file: what the network should be, in the user's terms. It holds
// decisions only, never device facts (models, ports, radios, versions), which
// are read from the devices when they are provisioned. The UI edits this file
// and nothing else; src/intent/compile.ts turns it into the low-level config.
import { z } from "zod";
import { choiceIssues } from "./choices";
import { countries } from "./countries";
import { where } from "./places";
import { steeringLevels } from "./roaming";
import {
  accessSchema,
  anywhere,
  firewallSchema,
  internet,
  isIpv6,
  reservedIds,
  router,
} from "./firewall";
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

/** An IPv4 address as a number, or undefined if it is not one. */
export const parseIpv4 = (address: string) => {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  const octets = match?.slice(1).map(Number);
  return octets && octets.every((o) => o <= 255)
    ? octets.reduce((n, o) => n * 256 + o, 0)
    : undefined;
};

/** A prefix length as a netmask: 24 -> 255.255.255.0. */
export const netmask = (length: number) => {
  const bits = 2 ** 32 - 2 ** (32 - length);
  return [24, 16, 8, 0].map((shift) => Math.floor(bits / 2 ** shift) % 256).join(".");
};

const ipv4 = z
  .string()
  .refine((a) => parseIpv4(a) !== undefined, "an IPv4 address, like 203.0.113.10");

/** A DNS server: IPv4, or IPv6 (hex and colons). */
const dnsServer = z
  .string()
  .refine(
    (a) => parseIpv4(a) !== undefined || (a.includes(":") && /^[0-9a-f:]+$/i.test(a)),
    "an IP address, like 9.9.9.9"
  );

/**
 * Smart queueing's per-packet overhead, by the kind of line: what the line
 * adds to every packet, from OpenWrt's SQM guidance. Too much only costs a
 * little speed; too little lets the modem's queue fill, which is the lag
 * queueing is there to prevent.
 */
export const lineTypes = ["fibre", "cable", "vdsl", "adsl"] as const;

/** How much IPv6 space to ask the provider for: each network takes a /64. */
export const ipv6Prefixes = ["auto", "48", "56", "60", "64"] as const;

export const securityModes = ["wpa2", "wpa2-wpa3", "wpa3"] as const;

export const intentVersion = 1;

export const bands = ["2g", "5g", "6g"] as const;
export type Band = (typeof bands)[number];

/** One band's radios, on every access point. */
const radio = (defaults: { enabled: boolean }) =>
  z
    .object({
      enabled: z.boolean().default(defaults.enabled),
      /** MHz; "auto" picks the band's usual width. */
      width: z.enum(["auto", "20", "40", "80", "160"]).default("auto"),
      /** Transmit power. Auto is the most the country allows. */
      power: z.enum(["auto", "low", "medium", "high"]).default("auto"),
      /** Fewer, faster clients near each access point; less range. */
      cell_density: z.enum(["off", "normal", "high", "very_high"]).default("normal"),
      /**
       * What the radio's queues favour: little queued for snappy calls and
       * games (latency), the kernel's own (balanced), or more queued to fill
       * the air (throughput). Per radio: every SSID on it shares its queues.
       */
      airtime: z.enum(["balanced", "latency", "throughput"]).default("balanced"),
    })
    .strict()
    .default({});

/** A MAC address, as aa:bb:cc:dd:ee:ff. */
export const macAddress = z
  .string()
  .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/, "like aa:bb:cc:dd:ee:ff");

/** A device that always gets the same address, and a name in DNS. */
const reservation = z
  .object({
    /** Also its DNS name: name.<local domain>. */
    name,
    mac: macAddress,
    address: z.string(),
  })
  .strict();

/** One SSH public key line: "ssh-ed25519 AAAA… comment". */
export const sshPublicKey = z
  .string()
  .trim()
  .regex(
    /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/]+={0,3}( [^\n]*)?$/,
    "an SSH public key, like ssh-ed25519 AAAA… you@computer"
  );

const network = z
  .object({
    /**
     * Stable and hidden: Wi-Fi refers to it, and it names the network on the
     * devices, so renaming never breaks a link. Short, as UCI names must be.
     */
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]{0,9}$/, "a short id")
      .refine((id) => !reservedIds.includes(id), "reserved"),
    name: z.string().min(1, "required").max(32),

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
        /** DNS servers handed to devices instead of the router (a Pi-hole, say). */
        dns_servers: z.array(ipv4).min(1, "at least one").optional(),
      })
      .strict()
      .default({ size: 150, lease: "12h" }),
    ipv6: z.boolean().default(true),
    access: accessSchema.default({}),
    reservations: z.array(reservation).default([]),
    /**
     * Devices on it (AirPlay, printers, Chromecast) are seen on the other
     * networks that share theirs, and theirs here: mDNS, reflected.
     */
    share_devices: z.boolean().default(false),
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
    /**
     * How this app logs in to the devices (ssh_key_path, password), and who
     * may log in as root at all: the compiler installs authorized_keys and
     * can turn password login off, so a device fresh from stock (which lets
     * root in with any password) is closed by its first apply.
     */
    admin: z
      .object({
        ssh_key_path: z.string().optional(),
        password: z.string().optional(),
        /** Public keys allowed to log in as root, as `ssh-keygen` writes them. */
        authorized_keys: z.array(sshPublicKey).default([]),
        /** Whether root may log in with a password; off needs an authorized key. */
        password_login: z.boolean().default(true),
      })
      .strict()
      .default({}),

    /** The routers and access points: what each is called and does. */
    hardware: z
      .array(
        z
          .object({
            name,
            role: z.enum(["router", "access-point"]),
            /** Where it is, like "Living room": shown in LuCI. */
            location: z.string().max(64).optional(),
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
          z
            .object({
              type: z.literal("static"),
              address: ipv4,
              prefix_length: z.number().int().min(8).max(30),
              gateway: ipv4,
              /** Needed unless encrypted DNS is on. */
              dns: z.array(dnsServer).optional(),
            })
            .strict(),
        ]),
        /** The provider's VLAN, for a line that must be tagged. */
        vlan: z.number().int().min(1, "1 to 4094").max(4094, "1 to 4094").optional(),
        ipv6: z.boolean().default(true),
        ipv6_prefix: z.enum(ipv6Prefixes).default("auto"),
        /** Devices on the main network may open ports for themselves (UPnP, NAT-PMP). */
        upnp: z.boolean().default(false),
        /** The line's speed. Set, it turns on smart queueing (less lag under load). */
        speed: z
          .object({
            down_mbps: z.number().positive(),
            up_mbps: z.number().positive(),
            line: z.enum(lineTypes).default("fibre"),
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

    firewall: firewallSchema,

    wifi: z.array(
      z
        .object({
          ssid: z.string().min(1, "required").max(32, "at most 32 characters"),
          /** Off: kept, but not broadcast. */
          enabled: z.boolean().default(true),
          /** The id of the network it joins. */
          network: z.string().min(1, "pick a network"),
          /** Where it is broadcast; unset, on every enabled band. */
          bands: z.array(z.enum(bands)).min(1, "at least one band").optional(),
          /**
           * Clients cannot reach each other: hostapd's isolation, within one
           * access point and band.
           */
          isolate_clients: z.boolean().default(false),
          /** WPA2; WPA2 and WPA3 side by side; or WPA3 only. 6 GHz is always WPA3. */
          security: z.enum(securityModes).default("wpa2"),
          password: wifiPassword,
          /** More passwords for the same network, e.g. one per person (WPA2 only). */
          extra_passwords: z.array(wifiPassword).optional(),
          /** Not announced: devices must be told its name. */
          hidden: z.boolean().default(false),
          /** 802.11r: devices move between access points without a pause. */
          fast_roaming: z.boolean().default(true),
          /** 802.11k/v: access points tell devices their neighbours, so they roam well. */
          roaming_assistance: z.boolean().default(true),
        })
        .strict()
    ),

    /** Per band, on every access point. */
    radios: z
      .object({
        "2g": radio({ enabled: true }),
        "5g": radio({ enabled: true }),
        // Off by default: few access points have it, and it needs WPA3.
        "6g": radio({ enabled: false }),
      })
      .strict()
      .default({}),

    /**
     * How the access points move devices to a better access point or band
     * (usteer), on the SSIDs with roaming assistance. Off gives no neighbour
     * lists at all; advise only gives them; nudge asks a fading device to
     * move; push also disconnects one that will not, or that stays too weak.
     * The values per level are in roaming.ts.
     */
    roaming: z
      .object({
        steering: z.enum(steeringLevels).default("advise"),
        /** Ask dual-band devices with a strong signal to leave 2.4 GHz. */
        prefer_5g: z.boolean().default(false),
      })
      .strict()
      .default({}),

    dns: z
      .object({
        /**
         * Where the router looks names up: the internet provider's servers,
         * a provider over encrypted DNS (DoH), or servers of your choice.
         */
        upstream: z
          .discriminatedUnion("type", [
            z.object({ type: z.literal("provider") }).strict(),
            z
              .object({
                type: z.literal("encrypted"),
                provider: z.enum(["cloudflare", "google", "quad9"]),
              })
              .strict(),
            z
              .object({
                type: z.literal("custom"),
                servers: z.array(dnsServer).min(1, "at least one server"),
              })
              .strict(),
          ])
          .default({ type: "provider" }),
        /** Devices are reachable as <name>.<local_domain>. */
        local_domain: name.default("lan"),
        /**
         * Refuse answers from the internet that point at your own addresses
         * (DNS rebinding), so a web page cannot reach devices inside.
         */
        rebind_protection: z.boolean().default(true),
        /** Your own names, like nas → 10.0.0.20: name.<local_domain>. */
        records: z
          .array(z.object({ name, address: z.string() }).strict())
          .default([]),
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
    const { connection } = intent.internet;
    if (connection.type === "static") {
      const at = (key: string) => ["internet", "connection", key];
      const address = parseIpv4(connection.address);
      const gateway = parseIpv4(connection.gateway);
      if (address !== undefined) {
        const size = 2 ** (32 - connection.prefix_length);
        const offset = address % size;
        if (offset === 0 || offset === size - 1) {
          issue(at("address"), "the subnet's own or broadcast address, not a host's");
        }
        if (gateway !== undefined && Math.floor(gateway / size) !== Math.floor(address / size)) {
          issue(at("gateway"), "not in the address's subnet");
        } else if (gateway === address) {
          issue(at("gateway"), "the router's own address");
        }
      }
      if (!connection.dns?.length && intent.dns.upstream.type === "provider") {
        issue(at("dns"), `add a DNS server, or choose other DNS servers under ${where("dns")}`);
      }
    }
    // What one setting may be given the rest: the rules the UI greys out by.
    choiceIssues(intent).forEach(({ path, message }) => issue(path, message));

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
    intent.wifi.forEach((wifi, i) => {
      // The UI cannot get here (choices.ts); a hand-edited file can.
      if (wifi.bands && !wifi.bands.some((band) => intent.radios[band].enabled)) {
        issue(["wifi", i, "bands"], `none of its bands is on (${where("radios")})`);
      }
    });
    const ids = intent.networks.map((n) => n.id);
    intent.wifi.forEach((wifi, i) => {
      if (!ids.includes(wifi.network)) {
        issue(["wifi", i, "network"], "pick a network");
      }
    });

    intent.dns.records.forEach((record, i) => {
      if (parseIpv4(record.address) === undefined && !(record.address.includes(":") && /^[0-9a-f:]+$/i.test(record.address))) {
        issue(["dns", "records", i, "address"], "an IP address, like 10.0.0.20");
      }
      if (intent.dns.records.slice(0, i).some((r) => r.name === record.name)) {
        issue(["dns", "records", i, "name"], "already used");
      }
    });

    // Reservations: inside their network, and each name, MAC and address once.
    const deviceNames = intent.hardware.map((d) => d.name);
    const seen = { name: new Set<string>(), mac: new Set<string>(), address: new Set<string>() };
    intent.networks.forEach((network, i) => {
      const prefix = network.subnet.split(".").slice(0, 3).join(".");
      network.reservations.forEach((r, j) => {
        const at = (key: string) => ["networks", i, "reservations", j, key];
        const host = Number(r.address.split(".")[3]);
        if (parseIpv4(r.address) === undefined || !r.address.startsWith(`${prefix}.`)) {
          issue(at("address"), `an address in ${prefix}.x`);
        } else if (host < 2 || host > 254) {
          issue(at("address"), `${prefix}.2 to ${prefix}.254 (.1 is the router)`);
        }
        if (deviceNames.includes(r.name)) issue(at("name"), "already a device's name");
        (["name", "mac", "address"] as const).forEach((key) => {
          if (seen[key].has(r[key])) issue(at(key), "already used");
          seen[key].add(r[key]);
        });
      });
    });

    // Access and rules name real networks.
    intent.networks.forEach((network, i) => {
      network.access.networks.forEach((id) => {
        if (id === network.id) {
          issue(["networks", i, "access", "networks"], "a network always reaches itself");
        } else if (!ids.includes(id)) {
          issue(["networks", i, "access", "networks"], `no network "${id}"`);
        }
      });
    });
    const { rules, port_forwards } = intent.firewall;
    rules.forEach((rule, i) => {
      const at = (key: string) => ["firewall", "rules", i, key];
      if (!ids.includes(rule.from) && rule.from !== internet && rule.from !== anywhere) {
        issue(at("from"), "pick a network, the internet or anywhere");
      }
      if (![internet, anywhere, router].includes(rule.to) && !ids.includes(rule.to)) {
        issue(at("to"), "pick a network, the router, the internet or anywhere");
      }
      const addresses = [...(rule.source_addresses ?? []), ...(rule.destination_addresses ?? [])];
      if (addresses.some(isIpv6) && addresses.some((a) => !isIpv6(a))) {
        issue(at("destination_addresses"), "IPv4 and IPv6 addresses cannot share a rule");
      }
    });
    const inANetwork = (address: string) =>
      intent.networks.some(
        (n) => address.split(".").slice(0, 3).join(".") === n.subnet.split(".").slice(0, 3).join(".")
      );
    port_forwards.forEach((forward, i) => {
      if (!inANetwork(forward.internal_address)) {
        issue(["firewall", "port_forwards", i, "internal_address"], "not on any of your networks");
      }
      const clash = port_forwards
        .slice(0, i)
        .some(
          (other) =>
            other.external_port === forward.external_port &&
            (other.protocol === forward.protocol ||
              other.protocol === "tcp+udp" ||
              forward.protocol === "tcp+udp")
        );
      if (clash) {
        issue(["firewall", "port_forwards", i, "external_port"], "already forwarded");
      }
    });
  });

export type Intent = z.infer<typeof intentSchema>;
/** What a file or the UI supplies: defaults not yet applied. */
export type IntentInput = z.input<typeof intentSchema>;
