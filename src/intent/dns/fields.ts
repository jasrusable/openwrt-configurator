// What each DNS setting is called and does, for people (fields.ts).
import type { FieldInfo } from "../feature";

export const dnsFields: FieldInfo[] = [
  { path: "dns", label: "DNS" },
  {
    path: "dns.domain",
    label: "Local domain",
    description: "Devices are reachable as name.domain.",
    openwrt: "dnsmasq domain",
    explain:
      "The suffix for local names: devices and reservations are found as <name>.<domain>, and lookups for it never leave the router.",
  },
  {
    path: "dns.upstream",
    label: "DNS servers",
    description: "Where the router looks names up.",
    openwrt: "dnsmasq servers · https-dns-proxy",
    explain:
      "Where the router looks names up. Encrypted sends lookups over HTTPS (DoH) to the provider, so your internet provider cannot read or alter them: dnsmasq forwards to https-dns-proxy on the router.",
  },
  { path: "dns.upstream.type", label: "Type" },
  { path: "dns.upstream.provider", label: "Encrypted DNS provider" },
  { path: "dns.upstream.servers", label: "Servers" },
  {
    path: "dns.rebind_protection",
    label: "Rebind protection",
    description: "Stops web pages from reaching devices at home.",
    openwrt: "dnsmasq rebind_protection",
    explain:
      "Refuses answers from the internet that point at private addresses, which blocks DNS rebinding attacks on devices at home. Turn it off if a service you use resolves to a local address on purpose.",
  },
  {
    path: "dns.hosts",
    label: "Local names",
    openwrt: "dnsmasq domain (hostname)",
    explain:
      "Your own names: <name>.<local domain> answers with the address you give, on every network.",
  },
  { path: "dns.hosts.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "dns.hosts.*.name", label: "Name" },
  { path: "dns.hosts.*.address", label: "Address" },
];
