// What remote access, provider tunnels and linked sites share between the
// compiler, the schema and the UI: their zones, addresses, a client's .conf,
// and a site's invitation. One place, so a client's file always matches what
// the router was given.
import { fromBase64, publicKeyOf, toBase64 } from "../../wireguard";
import { formatWgConf, WgConf } from "../../wireguardConf";
import { fromUtf8, toUtf8 } from "../../utf8";
import { hostIn } from "../addresses";
import { siteSeed, ulaPrefix } from "../site";
import { remoteAccessZone, sitesZone } from "../access";
import type { Intent } from "../schema";

export type VpnClient = Intent["vpn"]["remote_access"]["clients"][number];
export type Site = Intent["vpn"]["sites"]["peers"][number];

/** The zones remote access and sites add: targets of an access, like networks. */
export const vpnZones = (intent: Pick<Intent, "vpn">) => [
  ...(intent.vpn.remote_access.enabled ? [remoteAccessZone] : []),
  ...(intent.vpn.sites.peers.length ? [sitesZone] : []),
];

/** The router's address among the clients: .1. */
const vpnRouterAddress = (intent: Pick<Intent, "vpn">) => hostIn(intent.vpn.remote_access.subnet, 1);

/**
 * Its IPv6, from the networks' ULA prefix: the /64 numbered ffff. A network's
 * is its VLAN in hex (networks/compile.ts), at most ffe (VLAN 4094), so never this.
 */
const vpnUla = (intent: Pick<Intent, "system">) => ulaPrefix(siteSeed(intent)).replace("::/48", ":ffff::");

export const vpnRouterAddresses = (intent: Pick<Intent, "vpn" | "system">) => [
  `${vpnRouterAddress(intent)}/24`,
  `${vpnUla(intent)}1/64`,
];

/** A client's addresses: IPv4 by its host number, IPv6 in the VPN's /64. */
export const clientAddresses = (intent: Pick<Intent, "vpn" | "system">, client: Pick<VpnClient, "host">) => [
  hostIn(intent.vpn.remote_access.subnet, client.host),
  `${vpnUla(intent)}${client.host.toString(16)}`,
];

/** The lowest host number no client has. */
export const nextClientHost = (clients: Pick<VpnClient, "host">[]) => {
  for (let host = 2; host <= 254; host++) if (!clients.some((c) => c.host === host)) return host;
  return undefined;
};

/** Where clients and sites connect to: the address set, else the dynamic DNS name. */
export const vpnEndpoint = (intent: Pick<Intent, "vpn" | "internet">) => intent.vpn.remote_access.endpoint ?? intent.internet.dynamic_dns?.hostname;

/** host:port, an IPv6 address in brackets. */
export const withPort = (host: string, port: number) => (host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`);

/** Remote access may reach the linked sites: its clients route to them, and they route back. */
const vpnReachesSites = (intent: Pick<Intent, "vpn">) =>
  intent.vpn.remote_access.enabled && intent.vpn.sites.peers.length > 0 && intent.vpn.remote_access.access.networks.includes("sites");

/**
 * What a client sends through the tunnel: everything, or only home's ranges
 * (and the linked sites', when it may reach them). Everything is ::/0 too,
 * though the tunnel's IPv6 is only the site's ULA: else the client's own IPv6
 * would carry its traffic outside the tunnel. With only a ULA source, a
 * client prefers IPv4 for internet names (RFC 6724), which the tunnel carries.
 */
const clientRoutes = (intent: Pick<Intent, "vpn" | "networks" | "system">, client: Pick<VpnClient, "route">) =>
  client.route === "all"
    ? ["0.0.0.0/0", "::/0"]
    : [
        ...intent.networks.map((n) => n.subnet),
        intent.vpn.remote_access.subnet,
        ulaPrefix(siteSeed(intent)),
        ...(vpnReachesSites(intent) ? intent.vpn.sites.peers.flatMap((p) => p.subnets) : []),
      ];

/** A client's .conf (and QR code), with its private key, which only the page that made it has. */
export const clientConf = (
  intent: Pick<Intent, "vpn" | "networks" | "system" | "internet">,
  client: Pick<VpnClient, "host" | "route">,
  privateKey: string
) => {
  const conf: WgConf & { keepalive: number } = {
    privateKey,
    addresses: clientAddresses(intent, client).map((a, i) => `${a}/${i === 0 ? 32 : 128}`),
    dns: [vpnRouterAddress(intent)],
    peer: {
      publicKey: intent.vpn.remote_access.private_key ? publicKeyOf(intent.vpn.remote_access.private_key) : "",
      endpoint: withPort(vpnEndpoint(intent) ?? "your-address", intent.vpn.remote_access.port),
      allowedIps: clientRoutes(intent, client),
    },
    // Keeps a phone's tunnel open through mobile carriers' NAT.
    keepalive: 25,
  };
  return formatWgConf(conf);
};

/** What another site needs to link to this one: its key, where it is, its ranges. */
export type SiteInvite = { name: string; public_key: string; endpoint?: string; subnets: string[] };

export const inviteOf = (intent: Pick<Intent, "system" | "vpn" | "networks" | "internet">): SiteInvite | undefined =>
  intent.vpn.sites.private_key
    ? {
        name: intent.system.name,
        public_key: publicKeyOf(intent.vpn.sites.private_key),
        ...(vpnEndpoint(intent) ? { endpoint: withPort(vpnEndpoint(intent)!, intent.vpn.sites.port) } : {}),
        // Remote access's range too when its clients may reach the other
        // site: that site then routes their replies back here.
        subnets: [...intent.networks.map((n) => n.subnet), ...(vpnReachesSites(intent) ? [intent.vpn.remote_access.subnet] : [])],
      }
    : undefined;

const invitePrefix = "onc-site:";

/** An invitation as text to copy across: "onc-site:" and its JSON, base64. */
export const encodeInvite = (invite: SiteInvite) => invitePrefix + toBase64(toUtf8(JSON.stringify(invite)));

export const decodeInvite = (text: string): SiteInvite => {
  const body = text.trim();
  if (!body.startsWith(invitePrefix)) throw new Error("Not a site invitation: it starts with onc-site:");
  const invite = JSON.parse(fromUtf8(fromBase64(body.slice(invitePrefix.length))));
  if (typeof invite?.public_key !== "string" || !Array.isArray(invite?.subnets)) throw new Error("A broken invitation.");
  return invite as SiteInvite;
};

/**
 * A provider that gives no DNS servers: public ones, asked from the network
 * like any other address, so through the tunnel, never the router's own
 * upstream over the plain line.
 */
export const tunnelDefaultDns = ["9.9.9.9", "1.1.1.1"];

/** What a network out through `tunnel` is told to use for DNS. */
export const tunnelDns = (tunnel: { dns?: string[] }) => (tunnel.dns?.length ? tunnel.dns : tunnelDefaultDns);
