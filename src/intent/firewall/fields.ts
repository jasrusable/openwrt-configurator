// What each firewall setting is called and does, for people (fields.ts).
import type { FieldInfo } from "../feature";

export const firewallFields: FieldInfo[] = [
  { path: "firewall", label: "Firewall" },
  {
    path: "firewall.rules",
    label: "Rules",
    openwrt: "firewall rules",
    explain:
      "Exceptions to what each network's access allows, checked in order, between your networks, the internet and the router.",
  },
  { path: "firewall.rules.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "firewall.rules.*.name", label: "Name" },
  { path: "firewall.rules.*.enabled", label: "Enabled" },
  { path: "firewall.rules.*.from", label: "From" },
  { path: "firewall.rules.*.to", label: "To" },
  { path: "firewall.rules.*.from_addresses", label: "From devices", description: "Addresses or ranges, like 10.0.0.20 or 10.0.0.0/28." },
  { path: "firewall.rules.*.to_addresses", label: "To devices" },
  { path: "firewall.rules.*.protocol", label: "Protocol" },
  { path: "firewall.rules.*.ports", label: "Ports", description: "Like 443, 8000-8100 or 80 443." },
  {
    path: "firewall.rules.*.action",
    label: "Action",
    openwrt: "rule target: ACCEPT, DROP, REJECT",
    explain:
      "Allow or block. A block from the internet drops traffic silently; from your own networks it refuses it, so devices give up at once instead of waiting.",
  },
  {
    path: "firewall.port_forwards",
    label: "Port forwarding",
    openwrt: "firewall redirect (DNAT)",
    explain:
      "Opens a port on your internet address and passes what arrives to a device inside.",
  },
  { path: "firewall.port_forwards.*", label: (p) => `“${p?.name || "unnamed"}”` },
  { path: "firewall.port_forwards.*.name", label: "Name" },
  { path: "firewall.port_forwards.*.enabled", label: "Enabled" },
  { path: "firewall.port_forwards.*.protocol", label: "Protocol" },
  { path: "firewall.port_forwards.*.port", label: "External port", description: "A port or a range, like 27015 or 6881-6889." },
  { path: "firewall.port_forwards.*.to.address", label: "To address", description: "A device on one of your networks." },
  { path: "firewall.port_forwards.*.to.port", label: "To port", description: "Empty: the same as the external port." },
  { path: "firewall.port_forwards.*.from_addresses", label: "Only from", description: "Empty: from anywhere." },
  {
    path: "firewall.port_forwards.*.reflection",
    label: "NAT loopback",
    description: "Reachable from inside, by your public address, too.",
    openwrt: "redirect reflection",
    explain:
      "Lets devices at home reach the forward at your internet address too, so the same address works at home and away.",
  },
];
