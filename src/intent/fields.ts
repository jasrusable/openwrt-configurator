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

  { path: "network", label: "Network" },
  {
    path: "network.subnet",
    label: "Addresses",
    description: "Every device gets a new address; the router takes the first.",
  },
  {
    path: "network.domain",
    label: "Local domain",
    description: "Devices are reachable as name.domain.",
  },
  { path: "network.dhcp.size", label: "Addresses for devices" },
  { path: "network.dhcp.lease", label: "Lease time" },
  { path: "network.ipv6", label: "IPv6" },

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

  { path: "dns", label: "DNS" },
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
