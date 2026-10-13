// The intent file: what the network should be, in the user's terms. It holds
// decisions only, never device facts (models, ports, radios, versions), which
// are read from the devices when they are provisioned. The UI edits this file
// and nothing else; src/intent/compile.ts turns it into the low-level config.
import { z } from "zod";
import { choiceIssues, meshBands, meshChannels, meshWiredVlan } from "./choices";
import { countries } from "./countries";
import { ovpnUnsafe } from "./ovpn";
import { where } from "./places";
import { steeringLevels } from "./roaming";
import {
  accessSchema,
  anywhere,
  firewallSchema,
  internet,
  isIpv6,
  networkAccessSchema,
  reservedIds,
  router,
} from "./firewall";
import { timezones } from "./timezones";
import { wireguardKey } from "../wireguard";

/** A device's or network's name: a hostname's rules. */
export const namePattern = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

const name = z.string().regex(namePattern, "lowercase letters, digits and -, like a hostname");

const channel = z.union([z.literal("auto"), z.number().int().positive()]);

/** Each band's channel numbers (hostapd will not start on another band's). */
const channelsOf = {
  "2g": (c: number) => c >= 1 && c <= 14,
  "5g": (c: number) => c >= 32 && c <= 177 && c % 2 === 0,
} as const;

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

export const internetModes = ["failover", "balance"] as const;

const tunnelId = z.string().regex(/^tun\d$/, "an id like tun1");
const tunnelName = z.string().min(1, "required").max(32);

/** A WireGuard key, as `wg` prints it. */
const wgKey = z.string().regex(wireguardKey, "a WireGuard key (44 characters, ending in =)");

/** host:port, a name or an address ([…] for IPv6). */
const hostPort = z
  .string()
  .regex(/^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):\d{1,5}$/, "like vpn.example.com:51820");

/** A private IPv4 range of any size, as a remote site's: 10.1.0.0/16. */
const ipv4Cidr = z
  .string()
  .refine((cidr) => parseCidr(cidr) !== undefined, "an IPv4 range, like 192.168.10.0/24");

/** An IPv4 address with its prefix length, as a tunnel's own: 10.64.0.2/32. */
const ipv4WithPrefix = z
  .string()
  .regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, "like 10.64.0.2/32")
  .refine((a) => parseIpv4(a.split("/")[0]) !== undefined && Number(a.split("/")[1]) <= 32, "like 10.64.0.2/32");

/** A range as numbers: its first address and its size; undefined if it is not one. */
export const parseCidr = (cidr: string) => {
  const [address, length] = cidr.split("/");
  const start = parseIpv4(address ?? "");
  const bits = Number(length);
  if (start === undefined || !Number.isInteger(bits) || bits < 8 || bits > 32) return undefined;
  const size = 2 ** (32 - bits);
  return start % size === 0 ? { start, size } : undefined;
};

/** Whether two IPv4 ranges share any address. */
export const overlaps = (a: string, b: string) => {
  const [x, y] = [parseCidr(a), parseCidr(b)];
  return !!x && !!y && x.start < y.start + y.size && y.start < x.start + x.size;
};

/** Private and shared (CGNAT) ranges: what another site may claim. */
const privateRanges = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"];

/** Whether `cidr` lies wholly in a private range, so routing it to a site can take no internet address. */
export const isPrivateRange = (cidr: string) => {
  const r = parseCidr(cidr);
  return (
    !!r &&
    privateRanges.some((p) => {
      const q = parseCidr(p)!;
      return r.start >= q.start && r.start + r.size <= q.start + q.size;
    })
  );
};

export const vpnRoutes = ["home", "all"] as const;
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
          /** Needed unless encrypted DNS is on. */
          dns: z.array(dnsServer).optional(),
        })
        .strict(),
    })
    .strict(),
]);

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

/**
 * The names the compiler gives sections of its own: a network named so would
 * share a section with one (the engine refuses two of one name), so refused here.
 */
const fixedSectionNames = [
  "vpn", "sites", "loopback", "globals", "bat0", "batmesh", "batwired", "rescue", "odhcpd", "mesh", "meshport",
  "meshwired", "client", "config", "default", "defaults", "global", "https", "main", "nlbwmon", "ntp", "usteer",
];

const network = z
  .object({
    /**
     * Stable and hidden: Wi-Fi refers to it, and it names the network on the
     * devices, so renaming never breaks a link. Short, as UCI names must be.
     */
    id: z
      .string()
      .regex(/^[a-z][a-z0-9]{0,9}$/, "a short id")
      // Not "wan…", "tun…", "vpn" or "sites": the internet connections' and
      // the VPN's interfaces are named so.
      .refine(
        (id) => !reservedIds.includes(id) && !/^(wan|tun\d)/.test(id) && !fixedSectionNames.includes(id),
        "reserved"
      ),
    name: z.string().min(1, "required").max(32),

    /** Absent for the main network, which is untagged on every port. */
    vlan: z
      .number()
      .int()
      .min(2, "2 to 4094 (1 is the main network)")
      .max(4094, "2 to 4094")
      .optional(),
    subnet: ipv4Subnet,
    ipv6: z.boolean().default(true),
    dhcp: z
      .object({
        /** How many addresses it hands out (the pool ends at .254). */
        pool_size: z.number().int().min(1).max(253).default(150),
        lease: leaseTime.default("12h"),
        /** DNS servers handed to devices instead of the router (a Pi-hole, say). */
        dns_servers: z.array(ipv4).min(1, "at least one").optional(),
        /** Devices that always get the same address, and a name in DNS. */
        reservations: z.array(reservation).default([]),
      })
      .strict()
      .default({}),
    access: networkAccessSchema.default({}),
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

    /** The site, and who logs in to its devices. */
    system: z
      .object({
        name: z.string().min(1, "required"),
        timezone: z
          .string()
          .refine((zone) => zone in timezones, "an IANA zone, like Europe/Zurich"),
        /** Wi-Fi regulatory domain, ISO 3166 (CH, US, ...). */
        country: z
          .string()
          .refine((code) => countries.includes(code), "pick a country"),
        /** How this app logs in to the devices, as root. */
        app_login: z
          .object({
            /** The private key on this computer; else the agent's. */
            key: z.string().optional(),
            password: z.string().optional(),
          })
          .strict()
          .default({}),
        /**
         * Who may log in as root at all: the compiler installs
         * authorized_keys and can turn password login off, so a device fresh
         * from stock (which lets root in with any password) is closed by its
         * first apply.
         */
        ssh: z
          .object({
            /** Public keys allowed to log in as root, as `ssh-keygen` writes them. */
            authorized_keys: z.array(sshPublicKey).default([]),
            /** Whether root may log in with a password; off needs an authorized key. */
            password_login: z.boolean().default(true),
          })
          .strict()
          .default({}),
      })
      .strict(),

    internet: z
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
      .strict(),

    /**
     * The networks: one untagged main network, and any number on their own
     * VLANs (guests, IoT). Every LAN port and access point carries them all.
     */
    networks: z.array(network).min(1, "at least one network"),

    /** Wi-Fi: its networks (SSIDs), the radios, roaming between access points, the mesh. */
    wifi: z
      .object({
      networks: z.array(
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
            roaming: z
              .object({
                /** 802.11r: devices move between access points without a pause. */
                fast: z.boolean().default(true),
                /** 802.11k/v: access points tell devices their neighbours, so they roam well. */
                assisted: z.boolean().default(true),
              })
              .strict()
              .default({}),
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
      /**
       * Wireless backhaul: access points (and the router, with a radio) link
       * to each other over Wi-Fi (802.11s, with batman-adv routing over it), so
       * an access point needs no cable. Every node uses one band and channel.
       */
      mesh: z
        .object({
          enabled: z.boolean().default(false),
          band: z.enum(meshBands).default("5g"),
          /** Fixed: every node must be on it. Never a radar (DFS) channel, which a radar would move. */
          channel: z.number().int().default(36),
          /** Generated when the mesh is turned on; every node must have the same. */
          key: wifiPassword.optional(),
          /** The band is the mesh's alone: no SSID uses it (a tri-band access point's 6 GHz, say). */
          band_reserved: z.boolean().default(false),
          /** batman also over the cables between nodes, on a VLAN of its own: a cable when there is one, Wi-Fi when not. */
          over_cable: z.boolean().default(false),
          /** Over cables, batman's whole 1532-byte frames: every switch between nodes must pass them. Off, it splits its packets there. */
          large_frames: z.boolean().default(true),
        })
        .strict()
        .default({}),
      })
      .strict(),

    firewall: firewallSchema,

    /** VPN: remote access for phones and laptops, linked sites, and VPN providers to go out through. */
    vpn: z
      .object({
      /**
       * Remote access: phones and laptops reach home over WireGuard, as a zone
       * of their own with an access like a network's. Each client's private
       * key stays with the client; only its public key is kept.
       */
      remote_access: z
        .object({
          enabled: z.boolean().default(false),
          port: z.number().int().min(1).max(65535).default(51820),
          /** The clients' addresses. */
          subnet: ipv4Subnet.default("10.0.99.0/24"),
          /** Where clients connect to: a name or an address; unset, the dynamic DNS name. */
          /** A name or an address, without a port (the port is its own setting). */
          endpoint: z
            .string()
            .regex(/^([A-Za-z0-9.-]+|[0-9A-Fa-f]*:[0-9A-Fa-f:]*:[0-9A-Fa-f:]*)$/, "a name or an address, without a port")
            .optional(),
          /** The router's; made when remote access is turned on. */
          private_key: wgKey.optional(),
          access: accessSchema.default({ internet: true, networks: [], router: "full" }),
          clients: z
            .array(
              z
                .object({
                  id: z.string().regex(/^c\d{1,3}$/, "an id like c1"),
                  name: z.string().min(1, "required").max(32),
                  public_key: wgKey,
                  /** Its address in the subnet: .2 to .254, fixed so its config keeps working. */
                  host: z.number().int().min(2).max(254),
                  /** Everything through home, or only home's networks. */
                  route: z.enum(vpnRoutes).default("home"),
                })
                .strict()
            )
            .default([]),
        })
        .strict()
        .default({}),
      /** Other sites linked over WireGuard: each reaches the other's networks, as its access says. */
      sites: z
        .object({
          private_key: wgKey.optional(),
          port: z.number().int().min(1).max(65535).default(51821),
          access: accessSchema.default({ internet: false, networks: [], router: "services" }),
          peers: z
            .array(
              z
                .object({
                  id: z.string().regex(/^s\d{1,2}$/, "an id like s1"),
                  name: z.string().min(1, "required").max(32),
                  public_key: wgKey,
                  /** Where it is; unset, it connects to this site. */
                  endpoint: hostPort.optional(),
                  /** Its networks, which this site routes to it. */
                  subnets: z.array(ipv4Cidr).min(1, "at least one range"),
                })
                .strict()
            )
            .default([]),
        })
        .strict()
        .default({}),
      /**
       * VPN providers (Mullvad, Proton, …): tunnels a network's internet can
       * go out through (its Internet line), from the provider's .conf.
       */
      providers: z
        .array(
          z.union([
            z
              .object({
                id: tunnelId,
                name: tunnelName,
                type: z.literal("wireguard").default("wireguard"),
                private_key: wgKey,
                address: ipv4WithPrefix,
                /** The provider's DNS servers: the networks out through it use them (DHCP's option 6: IPv4 only, as the tunnel is). */
                dns: z.array(ipv4).optional(),
                peer: z
                  .object({ public_key: wgKey, preshared_key: wgKey.optional(), endpoint: hostPort })
                  .strict(),
              })
              .strict(),
            z
              .object({
                id: tunnelId,
                name: tunnelName,
                type: z.literal("openvpn"),
                /** The provider's .ovpn, as given (its keys inline). */
                config: z
                  .string()
                  .min(1, "paste the provider's .ovpn")
                  .refine((c) => /^\s*remote\s/m.test(c), "no remote in it")
                  .superRefine((c, ctx) => {
                    const unsafe = ovpnUnsafe(c);
                    if (unsafe.length) {
                      ctx.addIssue({
                        code: "custom",
                        message: `options a provider's file may not set here, as they could run or write things on the router: ${unsafe.join(", ")}`,
                      });
                    }
                  }),
                /** Where the provider asks for them: one line each in its login file. */
                username: z.string().regex(/^[^\r\n]*$/, "one line").optional(),
                password: z.string().regex(/^[^\r\n]*$/, "one line").optional(),
                dns: z.array(ipv4).optional(),
              })
              .strict(),
          ])
        )
        .default([]),
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
        /** Devices are reachable as <name>.<domain>. */
        domain: name.default("lan"),
        /**
         * Refuse answers from the internet that point at your own addresses
         * (DNS rebinding), so a web page cannot reach devices inside.
         */
        rebind_protection: z.boolean().default(true),
        /** Your own names, like nas → 10.0.0.20: name.<domain>. */
        hosts: z
          .array(z.object({ name, address: z.string() }).strict())
          .default([]),
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
            /** How an access point reaches the network: a cable, or the mesh. */
            uplink: z.enum(["cable", "mesh"]).default("cable"),
            /** Its own radios: a channel pinned per band; "auto" (the default) lets it choose. */
            radios: z
              .object({
                "2g": z
                  .object({ channel: channel.optional().refine((c) => c === undefined || c === "auto" || channelsOf["2g"](c), "a 2.4 GHz channel is 1 to 14") })
                  .strict()
                  .optional(),
                "5g": z
                  .object({ channel: channel.optional().refine((c) => c === undefined || c === "auto" || channelsOf["5g"](c), "a 5 GHz channel, like 36 or 149") })
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
  })
  .strict()
  .superRefine((intent, ctx) => {
    // Rules across settings, at the field they concern, so the UI shows them
    // there. The server applies the same ones: nothing invalid is saved.
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });
    intent.networks.forEach((network, i) => {
      const via = network.access.via;
      if (via && !intent.internet.lines.some((l) => l.id === via) && !intent.vpn.providers.some((t) => t.id === via)) {
        issue(["networks", i, "access", "via"], "pick a line");
      }
    });
    intent.internet.lines.forEach((line, c) => {
      if (intent.internet.lines.slice(0, c).some((other) => other.id === line.id)) {
        issue(["internet", "lines", c, "id"], "already used by another line");
      }
      if (line.type !== "static") return;
      const connection = line.static;
      const at = (key: string) => ["internet", "lines", c, "static", key];
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
    });
    const mesh = intent.wifi.mesh;
    if (mesh.enabled) {
      if (!mesh.key) issue(["wifi", "mesh", "key"], "required");
      if (mesh.over_cable) {
        intent.networks.forEach((n, i) => {
          if (n.vlan === meshWiredVlan) issue(["networks", i, "vlan"], `VLAN ${meshWiredVlan} carries the mesh over cables`);
        });
      }
      if (!meshChannels[mesh.band].includes(mesh.channel)) {
        issue(["wifi", "mesh", "channel"], `one of ${meshChannels[mesh.band].join(", ")}`);
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
    intent.wifi.networks.forEach((wifi, i) => {
      // The UI cannot get here (choices.ts); a hand-edited file can.
      if (wifi.bands && !wifi.bands.some((band) => intent.wifi.radios[band].enabled)) {
        issue(["wifi", "networks", i, "bands"], `none of its bands is on (${where("radios")})`);
      }
    });
    const ids = intent.networks.map((n) => n.id);
    // A network's IPv6 interface is its id and 6 (lan6): no other network may be named so.
    intent.networks.forEach((n, i) => {
      if (ids.some((other) => `${other}6` === n.id)) issue(["networks", i, "id"], "reserved");
    });
    // The VPN's zones, as targets of an access: its clients, the linked sites.
    // Remote access and sites stay valid targets while off: access to them
    // is kept for when they are back, and compiles to nothing meanwhile.
    const zones = ["vpn", "sites"];
    const { remote_access: remote, sites, providers } = intent.vpn;
    if (remote.enabled && !remote.private_key) issue(["vpn", "remote_access", "private_key"], "required");
    if (sites.peers.length && !sites.private_key) issue(["vpn", "sites", "private_key"], "required");
    remote.clients.forEach((client, i) => {
      if (remote.clients.slice(0, i).some((c) => c.host === client.host)) {
        issue(["vpn", "remote_access", "clients", i, "host"], "another client has this address");
      }
    });
    const unique = (list: { id: string }[], path: string[]) =>
      list.forEach((item, i) => {
        if (list.slice(0, i).some((o) => o.id === item.id)) issue([...path, i, "id"], `another has the id ${item.id}`);
      });
    unique(providers, ["vpn", "providers"]);
    unique(remote.clients, ["vpn", "remote_access", "clients"]);
    unique(sites.peers, ["vpn", "sites", "peers"]);
    if (remote.enabled && sites.peers.length && remote.port === sites.port) {
      issue(["vpn", "sites", "port"], "remote access uses this port");
    }
    const clash = remote.enabled && intent.networks.find((n) => overlaps(n.subnet, remote.subnet));
    if (clash) issue(["vpn", "remote_access", "subnet"], `overlaps ${clash.name}'s ${clash.subnet}`);
    const local = [...intent.networks.map((n) => n.subnet), ...(remote.enabled ? [remote.subnet] : [])];
    sites.peers.forEach((site, i) =>
      site.subnets.forEach((range) => {
        const at = ["vpn", "sites", "peers", i, "subnets"];
        // Routed to the site: an internet range would send that traffic there.
        if (!isPrivateRange(range)) return issue(at, `${range} is not a private range`);
        const mine = local.find((l) => overlaps(l, range));
        if (mine) return issue(at, `${range} overlaps this site's ${mine}`);
        const other = sites.peers.slice(0, i).find((p) => p.subnets.some((s) => overlaps(s, range)));
        if (other) issue(at, `${range} overlaps ${other.name}'s`);
      })
    );
    const accessOf = (path: (string | number)[], access: { networks: string[] }, own: string) =>
      access.networks.forEach((id) => {
        if (id === own || (!ids.includes(id) && !zones.includes(id))) issue([...path, "access", "networks"], `no network "${id}"`);
      });
    if (remote.enabled) accessOf(["vpn", "remote_access"], remote.access, "vpn");
    if (sites.peers.length) accessOf(["vpn", "sites"], sites.access, "sites");
    intent.wifi.networks.forEach((wifi, i) => {
      if (!ids.includes(wifi.network)) {
        issue(["wifi", "networks", i, "network"], "pick a network");
      }
    });

    intent.dns.hosts.forEach((record, i) => {
      if (parseIpv4(record.address) === undefined && !(record.address.includes(":") && /^[0-9a-f:]+$/i.test(record.address))) {
        issue(["dns", "hosts", i, "address"], "an IP address, like 10.0.0.20");
      }
      if (intent.dns.hosts.slice(0, i).some((r) => r.name === record.name)) {
        issue(["dns", "hosts", i, "name"], "already used");
      }
    });

    // Reservations: inside their network, and each name, MAC and address once.
    const deviceNames = intent.hardware.map((d) => d.name);
    const seen = { name: new Set<string>(), mac: new Set<string>(), address: new Set<string>() };
    intent.networks.forEach((network, i) => {
      const prefix = network.subnet.split(".").slice(0, 3).join(".");
      network.dhcp.reservations.forEach((r, j) => {
        const at = (key: string) => ["networks", i, "dhcp", "reservations", j, key];
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
        } else if (!ids.includes(id) && !zones.includes(id)) {
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
      const addresses = [...(rule.from_addresses ?? []), ...(rule.to_addresses ?? [])];
      if (addresses.some(isIpv6) && addresses.some((a) => !isIpv6(a))) {
        issue(at("to_addresses"), "IPv4 and IPv6 addresses cannot share a rule");
      }
    });
    const inANetwork = (address: string) =>
      intent.networks.some(
        (n) => address.split(".").slice(0, 3).join(".") === n.subnet.split(".").slice(0, 3).join(".")
      );
    // A DNS server it hands out on another network must be one it may reach.
    intent.networks.forEach((network, i) =>
      (network.dhcp.dns_servers ?? []).forEach((server, j) => {
        const on = intent.networks.find((n) => n.id !== network.id && overlaps(n.subnet, `${server}/32`));
        if (on && !network.access.networks.includes(on.id)) {
          issue(["networks", i, "dhcp", "dns_servers", j], `on ${on.name}, which this network cannot reach: give it access, or pick another`);
        }
      })
    );
    port_forwards.forEach((forward, i) => {
      const toAddress = ["firewall", "port_forwards", i, "to", "address"];
      if (!inANetwork(forward.to.address)) {
        issue(toAddress, "not on any of your networks");
      }
      // Into a network that goes out through a VPN provider's tunnel: its
      // replies would take the tunnel (policy routing by source), never
      // reaching whoever called in over the line.
      const target = intent.networks.find((n) => overlaps(n.subnet, `${forward.to.address}/32`));
      if (target?.access.via && providers.some((t) => t.id === target.access.via)) {
        issue(
          toAddress,
          `on ${target.name}, which goes out through a VPN provider: replies would leave through the tunnel, so the forward could never work`
        );
      }
      // A port forward is IPv4's (fw4 redirect, NAT): an IPv6 source would never match.
      if ((forward.from_addresses ?? []).some(isIpv6)) {
        issue(["firewall", "port_forwards", i, "from_addresses"], "IPv4 addresses only: a port forward is IPv4's");
      }
      // "8000-8100" and "8080" are the same port twice.
      const range = (ports: string) => {
        const [from, to = from] = ports.split("-").map(Number);
        return [from, to];
      };
      const overlap = (x: string, y: string) => {
        const [[a1, a2], [b1, b2]] = [range(x), range(y)];
        return a1 <= b2 && b1 <= a2;
      };
      const clash = port_forwards
        .slice(0, i)
        .some(
          (other) =>
            overlap(other.port, forward.port) &&
            (other.protocol === forward.protocol ||
              other.protocol === "tcp+udp" ||
              forward.protocol === "tcp+udp")
        );
      if (clash) {
        issue(["firewall", "port_forwards", i, "port"], "already forwarded");
      }
    });
  });

export type Intent = z.infer<typeof intentSchema>;
/** What a file or the UI supplies: defaults not yet applied. */
export type IntentInput = z.input<typeof intentSchema>;
