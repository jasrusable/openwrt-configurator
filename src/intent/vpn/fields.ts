// What each VPN setting is called and does, for people (fields.ts).
import type { FieldInfo } from "../feature";
import { tunnelDefaultDns } from "./model";

export const vpnFields: FieldInfo[] = [
  { path: "vpn", label: "VPN" },
  { path: "vpn.remote_access", label: "Remote access" },
  {
    path: "vpn.remote_access.enabled",
    label: "Remote access",
    description: "Phones and laptops reach home from anywhere, over WireGuard.",
    openwrt: "wireguard interface vpn",
    explain:
      "Runs a WireGuard server on the router. Each client has its own key and address, and lands in a zone of its own with the access set below, like a network's. A client's private key is made in this page and shown once, as a QR code and a file; only its public key is kept, so the settings file opens no device.",
  },
  {
    path: "vpn.remote_access.port",
    label: "Port",
    description: "The UDP port clients connect to.",
    openwrt: "wireguard listen_port",
    explain:
      "The router listens for WireGuard here, and the firewall lets it in from the internet. If your router is behind another one (its internet address is a private one), forward this UDP port to it there, or connect over IPv6.",
  },
  { path: "vpn.remote_access.subnet", label: "Addresses", description: "The clients' range; each keeps its own address." },
  {
    path: "vpn.remote_access.endpoint",
    label: "Address",
    description: "Where clients connect: a name or an address. Unset, your dynamic DNS name.",
  },
  { path: "vpn.remote_access.private_key", label: "Router's key", secret: true },
  { path: "vpn.remote_access.access", label: "Access" },
  {
    path: "vpn.remote_access.access.internet",
    label: "Internet",
    openwrt: "zone forwarding to wan",
    explain: "Whether remote clients can reach the internet through this router.",
  },
  {
    path: "vpn.remote_access.access.networks",
    label: "Can reach",
    description: "Your networks remote clients may connect to.",
    openwrt: "zone forwardings",
    explain: "The networks remote clients may open connections to, one firewall forwarding each. Replies always come back.",
  },
  {
    path: "vpn.remote_access.access.router",
    label: "Router access",
    description: "Full: anything on the router. Services: DNS and time only.",
    openwrt: "zone input",
  },
  { path: "vpn.remote_access.clients", label: "Clients" },
  { path: "vpn.remote_access.clients.*", label: (c) => `“${c?.name || "unnamed"}”` },
  { path: "vpn.remote_access.clients.*.name", label: "Name" },
  { path: "vpn.remote_access.clients.*.public_key", label: "Key", description: "Its public key: its private one stays on the device." },
  { path: "vpn.remote_access.clients.*.host", label: "Address" },
  {
    path: "vpn.remote_access.clients.*.route",
    label: "Through home",
    description: "Everything, or only your networks.",
    openwrt: "AllowedIPs",
    explain:
      "Everything: all its traffic goes through home, as if it were on your network (safer on public Wi-Fi; slower). Only your networks: it reaches home's networks and the router through the tunnel, and the rest of the internet directly.",
  },

  { path: "vpn.providers", label: "VPN providers" },
  { path: "vpn.providers.*", label: (t) => `“${t?.name || "unnamed"}”` },
  { path: "vpn.providers.*.name", label: "Name" },
  { path: "vpn.providers.*.type", label: "Kind", description: "WireGuard or OpenVPN, as the provider gives it." },
  { path: "vpn.providers.*.private_key", label: "Private key", secret: true },
  { path: "vpn.providers.*.address", label: "Address", description: "Its address in the provider's network." },
  {
    path: "vpn.providers.*.mtu",
    label: "MTU",
    description: "From the provider's file; empty is WireGuard's 1420.",
    openwrt: "network interface mtu",
    explain:
      "The largest packet the tunnel sends. Some providers need less than WireGuard's 1420, as their path adds headers, and say so in the .conf they give you (MTU =); larger packets would then stall. TCP is kept within it by MSS clamping on the tunnel's zone.",
  },
  {
    path: "vpn.providers.*.dns",
    label: "DNS servers",
    description: "The provider's: networks out through it are given them.",
    explain:
      `Devices on a network that goes out through this tunnel are handed these DNS servers, so their lookups go through the tunnel too instead of out the plain internet. None given: ${tunnelDefaultDns.join(" and ")}, also through the tunnel.`,
  },
  { path: "vpn.providers.*.peer", label: "Server" },
  { path: "vpn.providers.*.peer.public_key", label: "Server key" },
  { path: "vpn.providers.*.peer.preshared_key", label: "Preshared key", secret: true },
  { path: "vpn.providers.*.peer.endpoint", label: "Server address" },
  {
    path: "vpn.providers.*.config",
    label: "Provider's file",
    secret: true,
    description: "The .ovpn your provider gives you.",
    explain:
      "Used as given, with the router's own lines set last: its own device name; route-nopull, so the provider can never take the router's default route (the router sends only the networks you choose through it); no scripts; and its login file, with a username. Kept root's alone on the router.",
  },
  { path: "vpn.providers.*.username", label: "Username" },
  { path: "vpn.providers.*.password", label: "Password", secret: true },

  { path: "vpn.sites", label: "Sites" },
  { path: "vpn.sites.private_key", label: "This site's key", secret: true },
  {
    path: "vpn.sites.port",
    label: "Port",
    description: "The UDP port other sites connect to.",
    openwrt: "wireguard listen_port",
  },
  { path: "vpn.sites.access", label: "Access" },
  {
    path: "vpn.sites.access.internet",
    label: "Internet",
    openwrt: "zone forwarding to wan",
    explain: "Whether the linked sites can reach the internet through this router.",
  },
  {
    path: "vpn.sites.access.networks",
    label: "Can reach",
    description: "Your networks the linked sites may connect to.",
    openwrt: "zone forwardings",
    explain: "The networks the linked sites may open connections to, one firewall forwarding each. Replies always come back.",
  },
  {
    path: "vpn.sites.access.router",
    label: "Router access",
    description: "Full: anything on the router. Services: DNS and time only.",
    openwrt: "zone input",
  },
  { path: "vpn.sites.peers", label: "Linked sites" },
  { path: "vpn.sites.peers.*", label: (s) => `“${s?.name || "unnamed"}”` },
  { path: "vpn.sites.peers.*.name", label: "Name" },
  { path: "vpn.sites.peers.*.public_key", label: "Its key" },
  {
    path: "vpn.sites.peers.*.endpoint",
    label: "Its address",
    description: "Where it is; unset, it connects here.",
  },
  {
    path: "vpn.sites.peers.*.subnets",
    label: "Its networks",
    description: "The ranges behind it, routed to it.",
    openwrt: "allowed_ips, route_allowed_ips",
  },
];
