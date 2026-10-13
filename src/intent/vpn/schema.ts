// VPN: remote access for phones and laptops, linked sites, and VPN providers
// to go out through.
import { z } from "zod";
import { wireguardKey } from "../../wireguard";
import { accessSchema } from "../access";
import { isIpv6Address, isPort, parseCidr, parseIpv4 } from "../addresses";
import { ipv4, ipv4Subnet } from "../validators";
import { ovpnUnsafe } from "./ovpn";

export const vpnRoutes = ["home", "all"] as const;

const tunnelId = z.string().regex(/^tun\d$/, "an id like tun1");
const tunnelName = z.string().min(1, "required").max(32);

/** A WireGuard key, as `wg` prints it. */
const wgKey = z.string().regex(wireguardKey, "a WireGuard key (44 characters, ending in =)");

/** A host name, or an IP address. */
const hostName = /^[A-Za-z0-9.-]+$/;
const isHost = (host: string) => hostName.test(host) || isIpv6Address(host);

/** host:port, a name or an address ([…] for IPv6). */
const hostPort = z.string().refine((value) => {
  const [, ipv6, name, port] = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(value) ?? [];
  return (ipv6 !== undefined ? isIpv6Address(ipv6) : name !== undefined && hostName.test(name)) && isPort(port ?? "");
}, "like vpn.example.com:51820");

/** A private IPv4 range of any size, as a remote site's: 10.1.0.0/16. */
const ipv4Cidr = z
  .string()
  .refine((cidr) => parseCidr(cidr) !== undefined, "an IPv4 range, like 192.168.10.0/24");

/** An IPv4 address with its prefix length, as a tunnel's own: 10.64.0.2/32. */
const ipv4WithPrefix = z
  .string()
  .regex(/^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/, "like 10.64.0.2/32")
  .refine((a) => parseIpv4(a.split("/")[0]) !== undefined && Number(a.split("/")[1]) <= 32, "like 10.64.0.2/32");

export { isPrivateRange } from "../addresses";

/**
 * Remote access: phones and laptops reach home over WireGuard, as a zone
 * of their own with an access like a network's. Each client's private
 * key stays with the client; only its public key is kept.
 */
const remoteAccessSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(51820),
    /** The clients' addresses. */
    subnet: ipv4Subnet.default("10.0.99.0/24"),
    /** Where clients connect to: a name or an address, without a port (its own setting); unset, the dynamic DNS name. */
    endpoint: z.string().refine(isHost, "a name or an address, without a port").optional(),
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
  .default({});

/** Other sites linked over WireGuard: each reaches the other's networks, as its access says. */
const sitesSchema = z
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
  .default({});

/**
 * VPN providers (Mullvad, Proton, …): tunnels a network's internet can go
 * out through (its Internet line), from the provider's .conf.
 */
const providersSchema = z
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
          /**
           * The tunnel's MTU from the provider's .conf; unset, WireGuard's
           * own 1420. A provider that needs less (its path adds headers)
           * says so in the file, and larger packets would otherwise stall.
           */
          mtu: z.number().int().min(1280, "1280 to 1500").max(1500, "1280 to 1500").optional(),
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
  .default([]);

export const vpnSchema = z
  .object({
    remote_access: remoteAccessSchema,
    sites: sitesSchema,
    providers: providersSchema,
  })
  .strict()
  .default({});
