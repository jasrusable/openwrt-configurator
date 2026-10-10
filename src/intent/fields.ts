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
  { path: "site.timezone", label: "Time zone" },
  {
    path: "site.country",
    label: "Country",
    description: "Sets which Wi-Fi channels and power levels are allowed.",
  },
  { path: "admin", label: "Administration" },
  { path: "admin.ssh_key_path", label: "SSH key" },
  { path: "admin.password", label: "Password", secret: true },

  { path: "devices", label: "Devices" },
  { path: "devices.*", label: (d) => `“${d?.name || "unnamed"}”` },
  { path: "devices.*.name", label: "Name", description: "Also its hostname." },
  {
    path: "devices.*.role",
    label: "Role",
    description: "A router connects to the internet; an access point broadcasts Wi-Fi.",
  },
  { path: "devices.*.wifi", label: "Wi-Fi" },
  { path: "devices.*.wifi.channel.2g", label: "2.4 GHz channel" },
  { path: "devices.*.wifi.channel.5g", label: "5 GHz channel" },

  { path: "internet", label: "Internet" },
  {
    path: "internet.connection",
    label: "Connection",
    description: "How the router reaches your provider.",
  },
  { path: "internet.connection.type", label: "Type" },
  { path: "internet.connection.username", label: "Username" },
  { path: "internet.connection.password", label: "Password", secret: true },
  { path: "internet.ipv6", label: "IPv6" },
  {
    path: "internet.speed",
    label: "Smart queueing",
    description:
      "Shapes traffic to your line's speed, so calls and games stay smooth under load.",
  },
  { path: "internet.speed.down_mbps", label: "Download", unit: "Mbit/s" },
  { path: "internet.speed.up_mbps", label: "Upload", unit: "Mbit/s" },

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
  { path: "networks.*.ipv6", label: "IPv6" },

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
    path: "wifi.*.network",
    label: "Network",
    description: "Devices joining this Wi-Fi land on that network.",
  },

  { path: "firewall", label: "Firewall" },
  { path: "firewall.defaults", label: "Defaults" },
  { path: "firewall.defaults.input", label: "Input" },
  { path: "firewall.defaults.output", label: "Output" },
  { path: "firewall.defaults.forward", label: "Forward" },
  { path: "firewall.defaults.syn_flood_protection", label: "SYN flood protection" },
  { path: "firewall.defaults.drop_invalid", label: "Drop invalid packets" },
  { path: "firewall.zones", label: "Zones" },
  { path: "firewall.zones.*", label: (z) => `“${z?.name || z?.id || "unnamed"}”` },
  { path: "firewall.zones.*.name", label: "Name" },
  { path: "firewall.zones.*.networks", label: "Networks" },
  { path: "firewall.zones.*.input", label: "Input", description: "Traffic to the router itself." },
  { path: "firewall.zones.*.forward", label: "Forward", description: "Traffic between the zone's own networks." },
  { path: "firewall.zones.*.output", label: "Output" },
  { path: "firewall.zones.*.masquerade", label: "Masquerading" },
  { path: "firewall.zones.*.mss_clamping", label: "MSS clamping" },
  { path: "firewall.forwardings", label: "Zone forwarding" },
  { path: "firewall.forwardings.*", label: (f) => `${f?.from} → ${f?.to}` },
  { path: "firewall.forwardings.*.from", label: "From" },
  { path: "firewall.forwardings.*.to", label: "To" },
  { path: "firewall.rules", label: "Rules" },
  { path: "firewall.rules.*", label: (r) => `“${r?.name || "unnamed"}”` },
  { path: "firewall.rules.*.name", label: "Name" },
  { path: "firewall.rules.*.enabled", label: "Enabled" },
  { path: "firewall.rules.*.from", label: "From" },
  { path: "firewall.rules.*.to", label: "To" },
  { path: "firewall.rules.*.source_addresses", label: "Source addresses" },
  { path: "firewall.rules.*.source_port", label: "Source port" },
  { path: "firewall.rules.*.destination_port", label: "Destination port" },
  { path: "firewall.rules.*.icmp_types", label: "ICMP types" },
  { path: "firewall.rules.*.limit", label: "Limit" },
  { path: "firewall.rules.*.destination_addresses", label: "Destination addresses" },
  { path: "firewall.rules.*.protocols", label: "Protocols" },
  { path: "firewall.rules.*.family", label: "IP version" },
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
    path: "dns.over_https",
    label: "Encrypted DNS",
    description: "Lookups go encrypted to this provider instead of your ISP's.",
  },
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
