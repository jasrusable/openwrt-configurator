// What each network setting is called and does, for people (fields.ts).
import type { FieldInfo } from "../feature";

export const networksFields: FieldInfo[] = [
  { path: "networks", label: "Networks" },
  { path: "networks.*", label: (n) => `“${n?.name || "unnamed"}”` },
  { path: "networks.*.name", label: "Name" },
  {
    path: "networks.*.access.via",
    label: "Internet line",
    description: "Which internet connection or VPN provider its devices use.",
    openwrt: "mwan3 policy and rule; for a VPN provider, netifd rules",
    explain:
      "Unset, its devices go out as the internet's setting says (failover or sharing). Set, they go out the connection or VPN provider chosen. A connection: when it is down they use the others, or have no internet until it is back; IPv4 only, IPv6 always uses the first one. A VPN provider: when it is down they have no internet (a kill switch), the network has no IPv6, which would go around the tunnel, and its DNS goes through the tunnel too. The router itself, and other networks, are not affected.",
  },
  { path: "networks.*.access.fallback", label: "Use the others when it is down" },
  {
    path: "networks.*.vlan",
    label: "VLAN",
    description: "Any switch between your devices must carry it.",
    openwrt: "bridge-vlan",
    explain:
      "The VLAN ID this network uses. The router and access points tag it on their ports for you; a managed switch between them must carry the same VLAN, tagged.",
  },
  {
    path: "networks.*.subnet",
    label: "Addresses",
    description: "Every device on it gets a new address; the router takes the first.",
  },
  {
    path: "networks.*.dhcp.pool_size",
    label: "Addresses for devices",
    openwrt: "dhcp start / limit",
    explain:
      "How many addresses DHCP hands out, counted down from .254. The rest, from .2 up, stay free for devices you give a fixed address yourself.",
  },
  {
    path: "networks.*.dhcp.lease",
    label: "Lease time",
    openwrt: "dhcp leasetime",
    explain:
      "How long a device keeps its address before renewing it. Shorter frees addresses sooner on a busy guest network; longer means fewer renewals.",
  },
  {
    path: "networks.*.dhcp.dns_servers",
    label: "DNS servers handed out",
    description: "Devices ask these instead of the router.",
    openwrt: "dhcp_option 6",
    explain:
      "Tells devices to ask these DNS servers instead of the router, e.g. a Pi-hole. They then bypass the router's encrypted DNS and its local names.",
  },
  {
    path: "networks.*.ipv6",
    label: "IPv6",
    openwrt: "ip6assign 64 · odhcpd",
    explain:
      "Gives this network one /64 of the internet's IPv6 prefix, announced by router advertisements and DHCPv6 from the router (odhcpd). Devices get public IPv6 addresses, plus a stable private one that never changes.",
  },
  {
    path: "networks.*.dhcp.reservations",
    label: "Reserved addresses",
    openwrt: "dhcp host (static lease)",
    explain:
      "Devices that always get the same IPv4 address, matched by MAC address, and a name: <name>.<local domain>. Rules and port forwards that point at a device need one.",
  },
  { path: "networks.*.dhcp.reservations.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "networks.*.dhcp.reservations.*.name", label: "Name" },
  { path: "networks.*.dhcp.reservations.*.mac", label: "MAC address" },
  { path: "networks.*.dhcp.reservations.*.address", label: "Address" },
  {
    path: "networks.*.share_devices",
    label: "Share devices with other networks",
    description: "AirPlay, printers and Chromecasts are seen across the networks that share.",
    openwrt: "avahi reflector",
    explain:
      "Repeats mDNS (Bonjour) between the networks that share, so AirPlay speakers, printers and Chromecasts on one are found from the others. It only makes them visible: reaching them still needs Can reach.",
  },
  { path: "networks.*.access", label: "Access" },
  {
    path: "networks.*.access.internet",
    label: "Internet",
    openwrt: "zone forwarding to wan",
    explain:
      "Whether devices on this network can reach the internet: a firewall forwarding from this network's zone to the wan zone.",
  },
  {
    path: "networks.*.access.networks",
    label: "Can reach",
    description: "Other networks its devices may connect to.",
    openwrt: "zone forwardings",
    explain:
      "The other networks this one may open connections to, one firewall forwarding each. Replies always come back, so a network can answer this one without being given access to it.",
  },
  {
    path: "networks.*.access.router",
    label: "Router access",
    description: "Services: addresses, DNS and time. Full: also admin and SSH.",
    openwrt: "zone input",
    explain:
      "Full lets devices reach everything on the router, the admin pages and SSH included. Network services rejects everything but DHCP, DNS, NTP and the IPv6 essentials, which suits guests and IoT.",
  },
];
