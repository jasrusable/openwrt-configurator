// What remote access, provider tunnels and linked sites share between the
// compiler, the schema and the UI: their zones, addresses, a client's .conf,
// and a site's invitation. One place, so a client's file always matches what
// the router was given.
import { publicKeyOf } from "../wireguard";
import { formatWgConf, WgConf } from "../wireguardConf";
import { fromUtf8, toUtf8 } from "../utf8";
import { fromBase64, toBase64 } from "../wireguard";
import { ulaPrefix } from "./features/network";
import type { Intent } from "./schema";

export type VpnClient = Intent["vpn"]["clients"][number];
export type Site = Intent["sites"]["peers"][number];

/** The zones remote access and sites add: targets of an access, like networks. */
export const vpnZones = (intent: Pick<Intent, "vpn" | "sites">) => [
  ...(intent.vpn.enabled ? ["vpn"] : []),
  ...(intent.sites.peers.length ? ["sites"] : []),
];

/** The first three parts of a /24: "10.0.99" for 10.0.99.0/24. */
const prefixOf = (subnet: string) => subnet.split(".").slice(0, 3).join(".");

/** The router's address among the clients: .1. */
export const vpnRouterAddress = (intent: Pick<Intent, "vpn">) => `${prefixOf(intent.vpn.subnet)}.1`;

/** Its IPv6, from the networks' ULA prefix: the /64 numbered ff, never a network's. */
const vpnUla = (intent: Pick<Intent, "site">) => ulaPrefix(intent.site.name).replace("::/48", ":ff::");

export const vpnRouterAddresses = (intent: Pick<Intent, "vpn" | "site">) => [
  `${vpnRouterAddress(intent)}/24`,
  `${vpnUla(intent)}1/64`,
];

/** A client's addresses: IPv4 by its host number, IPv6 in the VPN's /64. */
export const clientAddresses = (intent: Pick<Intent, "vpn" | "site">, client: Pick<VpnClient, "host">) => [
  `${prefixOf(intent.vpn.subnet)}.${client.host}`,
  `${vpnUla(intent)}${client.host.toString(16)}`,
];

/** The lowest host number no client has. */
export const nextClientHost = (clients: Pick<VpnClient, "host">[]) => {
  for (let host = 2; host <= 254; host++) if (!clients.some((c) => c.host === host)) return host;
  return undefined;
};

/** Where clients and sites connect to: the address set, else the dynamic DNS name. */
export const vpnEndpoint = (intent: Pick<Intent, "vpn" | "internet">) => intent.vpn.endpoint ?? intent.internet.ddns?.hostname;

/** What a client sends through the tunnel: everything, or only home's ranges. */
const clientRoutes = (intent: Pick<Intent, "vpn" | "networks" | "site">, client: Pick<VpnClient, "route">) =>
  client.route === "all"
    ? ["0.0.0.0/0", "::/0"]
    : [...intent.networks.map((n) => n.subnet), intent.vpn.subnet, ulaPrefix(intent.site.name)];

/** A client's .conf (and QR code), with its private key, which only the page that made it has. */
export const clientConf = (
  intent: Pick<Intent, "vpn" | "networks" | "site" | "internet">,
  client: Pick<VpnClient, "host" | "route">,
  privateKey: string
) => {
  const conf: WgConf & { keepalive: number } = {
    privateKey,
    addresses: clientAddresses(intent, client).map((a, i) => `${a}/${i === 0 ? 32 : 128}`),
    dns: [vpnRouterAddress(intent)],
    peer: {
      publicKey: intent.vpn.private_key ? publicKeyOf(intent.vpn.private_key) : "",
      endpoint: `${vpnEndpoint(intent) ?? "your-address"}:${intent.vpn.port}`,
      allowedIps: clientRoutes(intent, client),
    },
    // Keeps a phone's tunnel open through mobile carriers' NAT.
    keepalive: 25,
  };
  return formatWgConf(conf);
};

/** What another site needs to link to this one: its key, where it is, its ranges. */
export type SiteInvite = { name: string; public_key: string; endpoint?: string; subnets: string[] };

export const inviteOf = (intent: Pick<Intent, "site" | "sites" | "networks" | "vpn" | "internet">): SiteInvite | undefined =>
  intent.sites.private_key
    ? {
        name: intent.site.name,
        public_key: publicKeyOf(intent.sites.private_key),
        ...(vpnEndpoint(intent) ? { endpoint: `${vpnEndpoint(intent)}:${intent.sites.port}` } : {}),
        subnets: intent.networks.map((n) => n.subnet),
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
