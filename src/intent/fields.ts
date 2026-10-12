// What each intent setting is called and what it does, for people: the
// provision page explains a change with it. Patterns use * for a list index;
// a pattern for a list item names the item from its value.
export type FieldInfo = {
  path: string;
  label: string | ((item: any) => string);
  description?: string;
  /** Never shown, even in a diff. */
  secret?: boolean;
  unit?: string;
};

export const fields: FieldInfo[] = [
  { path: "site", label: "General" },
  { path: "site.name", label: "Name" },
  {
    path: "site.timezone",
    label: "Time zone",
    description: "Access points also broadcast it, so clients can set their clocks (802.11v).",
  },
  {
    path: "site.country",
    label: "Country",
    description:
      "Sets which Wi-Fi channels and power levels are allowed; access points announce it to clients (802.11d).",
  },
  { path: "admin", label: "Administration" },
  { path: "admin.ssh_key_path", label: "SSH key" },
  { path: "admin.password", label: "Password", secret: true },

  { path: "hardware", label: "Hardware" },
  { path: "hardware.*", label: (d) => `“${d?.name || "unnamed"}”` },
  { path: "hardware.*.name", label: "Name", description: "Also its hostname." },
  {
    path: "hardware.*.role",
    label: "Role",
    description: "A router connects to the internet; an access point broadcasts Wi-Fi.",
  },
  { path: "hardware.*.location", label: "Location" },
  { path: "hardware.*.wifi", label: "Wi-Fi" },
  { path: "hardware.*.wifi.channel.2g", label: "2.4 GHz channel" },
  { path: "hardware.*.wifi.channel.5g", label: "5 GHz channel" },

  { path: "internet", label: "Internet" },
  {
    path: "internet.connection",
    label: "Connection",
    description: "How the router reaches your provider.",
  },
  { path: "internet.connection.type", label: "Type" },
  { path: "internet.connection.username", label: "Username" },
  { path: "internet.connection.password", label: "Password", secret: true },
  { path: "internet.connection.address", label: "IP address" },
  { path: "internet.connection.prefix_length", label: "Subnet mask" },
  { path: "internet.connection.gateway", label: "Gateway" },
  { path: "internet.connection.dns", label: "DNS servers" },
  {
    path: "internet.vlan",
    label: "VLAN tag",
    description: "Some providers need the line tagged with a VLAN.",
  },
  { path: "internet.ipv6", label: "IPv6" },
  {
    path: "internet.ipv6_prefix",
    label: "IPv6 prefix size",
    description: "How much address space to ask your provider for; each network with IPv6 needs a /64.",
  },
  {
    path: "internet.speed",
    label: "Smart queueing",
    description:
      "Shapes traffic to your line's speed, so calls and games stay smooth under load.",
  },
  {
    path: "internet.upnp",
    label: "UPnP and NAT-PMP",
    description: "Games and apps on the main network open ports for themselves.",
  },
  { path: "internet.speed.down_mbps", label: "Download", unit: "Mbit/s" },
  { path: "internet.speed.up_mbps", label: "Upload", unit: "Mbit/s" },
  {
    path: "internet.speed.line",
    label: "Line type",
    description: "Sets how much each packet really costs on the line.",
  },

  { path: "networks", label: "Networks" },
  { path: "networks.*", label: (n) => `“${n?.name || "unnamed"}”` },
  { path: "networks.*.name", label: "Name" },
  { path: "networks.*.purpose", label: "Purpose" },
  {
    path: "networks.*.vlan",
    label: "VLAN",
    description: "Switches between your devices must carry it.",
  },
  {
    path: "networks.*.subnet",
    label: "Addresses",
    description: "Every device on it gets a new address; the router takes the first.",
  },
  { path: "networks.*.dhcp.size", label: "Addresses for devices" },
  { path: "networks.*.dhcp.lease", label: "Lease time" },
  {
    path: "networks.*.dhcp.dns_servers",
    label: "DNS servers handed out",
    description: "Devices ask these instead of the router.",
  },
  { path: "networks.*.ipv6", label: "IPv6" },
  { path: "networks.*.reservations", label: "Reserved addresses" },
  { path: "networks.*.reservations.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "networks.*.reservations.*.name", label: "Name" },
  { path: "networks.*.reservations.*.mac", label: "MAC address" },
  { path: "networks.*.reservations.*.address", label: "Address" },
  {
    path: "networks.*.share_devices",
    label: "Share devices with other networks",
    description: "AirPlay, printers and Chromecasts are seen across the networks that share.",
  },
  { path: "networks.*.access", label: "Access" },
  { path: "networks.*.access.internet", label: "Internet" },
  {
    path: "networks.*.access.networks",
    label: "Can reach",
    description: "Other networks its devices may connect to.",
  },
  {
    path: "networks.*.access.router",
    label: "Router access",
    description: "Full: anything on the router. Services: addresses, DNS and time only.",
  },

  { path: "wifi", label: "Wi-Fi" },
  { path: "wifi.*", label: (w) => `“${w?.ssid || "unnamed"}”` },
  {
    path: "wifi.*.ssid",
    label: "Name",
    description: "Devices will have to join the network again under its new name.",
  },
  {
    path: "wifi.*.password",
    label: "Password",
    secret: true,
    description: "Devices will have to join again with the new password.",
  },
  { path: "wifi.*.extra_passwords", label: "More passwords", secret: true },
  { path: "wifi.*.enabled", label: "Enabled" },
  {
    path: "wifi.*.security",
    label: "Security",
    description: "WPA3 is stronger; WPA2/WPA3 lets older devices still join.",
  },
  { path: "wifi.*.hidden", label: "Hidden" },
  {
    path: "wifi.*.roaming_assistance",
    label: "Roaming assistance",
    description: "Access points tell devices about their neighbours (802.11k/v).",
  },
  {
    path: "wifi.*.fast_roaming",
    label: "Fast roaming",
    description: "Devices move between access points without a pause (802.11r).",
  },
  { path: "wifi.*.bands", label: "Bands" },
  {
    path: "wifi.*.isolate_clients",
    label: "Isolate clients",
    description: "Whether devices on it, on the same access point and band, are kept from reaching each other.",
  },
  { path: "radios", label: "Radios" },
  { path: "radios.2g", label: "2.4 GHz" },
  { path: "radios.5g", label: "5 GHz" },
  { path: "radios.6g", label: "6 GHz" },
  { path: "radios.*.enabled", label: "Enabled" },
  { path: "radios.*.width", label: "Channel width" },
  { path: "radios.*.power", label: "Transmit power" },
  { path: "radios.*.cell_density", label: "Cell density" },
  {
    path: "radios.*.airtime",
    label: "Airtime",
    description: "What the band's Wi-Fi queues favour: latency, balance or throughput.",
  },
  {
    path: "wifi.*.network",
    label: "Network",
    description: "Devices joining this Wi-Fi land on that network.",
  },

  { path: "firewall", label: "Firewall" },
  { path: "firewall.rules", label: "Rules" },
  { path: "firewall.rules.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "firewall.rules.*.name", label: "Name" },
  { path: "firewall.rules.*.enabled", label: "Enabled" },
  { path: "firewall.rules.*.from", label: "From" },
  { path: "firewall.rules.*.to", label: "To" },
  { path: "firewall.rules.*.source_addresses", label: "Only from" },
  { path: "firewall.rules.*.destination_addresses", label: "Only to" },
  { path: "firewall.rules.*.protocol", label: "Protocol" },
  { path: "firewall.rules.*.destination_port", label: "Ports" },
  { path: "firewall.rules.*.action", label: "Action" },
  { path: "firewall.port_forwards", label: "Port forwarding" },
  { path: "firewall.port_forwards.*", label: (p) => `“${p?.name || "unnamed"}”` },
  { path: "firewall.port_forwards.*.name", label: "Name" },
  { path: "firewall.port_forwards.*.enabled", label: "Enabled" },
  { path: "firewall.port_forwards.*.protocol", label: "Protocol" },
  { path: "firewall.port_forwards.*.external_port", label: "External port" },
  { path: "firewall.port_forwards.*.internal_address", label: "Internal address" },
  { path: "firewall.port_forwards.*.internal_port", label: "Internal port" },
  { path: "firewall.port_forwards.*.source_addresses", label: "Only from" },
  { path: "firewall.port_forwards.*.reflection", label: "NAT loopback" },

  { path: "dns", label: "DNS" },
  {
    path: "dns.local_domain",
    label: "Local domain",
    description: "Devices are reachable as name.domain.",
  },
  {
    path: "dns.upstream",
    label: "DNS servers",
    description: "Where the router looks names up.",
  },
  { path: "dns.upstream.type", label: "Type" },
  { path: "dns.upstream.provider", label: "Encrypted DNS provider" },
  { path: "dns.upstream.servers", label: "Servers" },
  {
    path: "dns.rebind_protection",
    label: "Rebind protection",
    description: "Answers from the internet may not point at your own addresses.",
  },
  { path: "dns.records", label: "Local names" },
  { path: "dns.records.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "dns.records.*.name", label: "Name" },
  { path: "dns.records.*.address", label: "Address" },
];

const matches = (pattern: string, path: string[]) => {
  const parts = pattern.split(".");
  return (
    parts.length === path.length &&
    parts.every((part, i) => part === "*" || part === path[i])
  );
};

export const fieldInfo = (path: string[]) =>
  fields.find((field) => matches(field.path, path));
