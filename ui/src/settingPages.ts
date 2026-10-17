// Which page shows each setting, kept apart from the pages themselves so
// anything (the problems list, a removal's consequences) can use it.
/**
 * Which page shows each setting, by the start of its path; for a list, the
 * URL of one item's page. The problems list and the sidebar's marks use it.
 */
export const settingPages: { path: string; page: string; url?: string; item?: (index: string) => string }[] = [
  // The catalog is a tab of System, for the list and for one entry in it.
  { path: "system.patches", page: "system", url: "/settings/system/patches" },
  { path: "system.firmware", page: "system", url: "/settings/system/firmware" },
  // A device's firmware is set in the Firmware tab's table, beside the others'.
  { path: "hardware.*.firmware", page: "system", url: "/settings/system/firmware" },
  { path: "system", page: "system" },
  { path: "internet.lines", page: "internet", item: (i) => `/settings/internet/${i}` },
  { path: "internet", page: "internet" },
  { path: "firewall.rules", page: "firewall", item: (i) => `/settings/firewall/rules/${i}` },
  { path: "firewall.port_forwards", page: "firewall", item: (i) => `/settings/firewall/${i}` },
  { path: "firewall", page: "firewall" },
  { path: "networks", page: "networks", item: (i) => `/settings/networks/${i}` },
  { path: "wifi.networks", page: "wifi", item: (i) => `/settings/wifi/${i}` },
  { path: "wifi.radios", page: "wifi", item: (band) => `/settings/wifi/radios/${band}` },
  { path: "wifi.roaming", page: "wifi", item: () => "/settings/wifi/roaming" },
  { path: "wifi.mesh", page: "wifi", item: () => "/settings/wifi/mesh" },
  { path: "wifi", page: "wifi" },
  { path: "dns", page: "dns" },
  // Most specific first: the first whose path starts the setting's is its page.
  { path: "vpn.remote_access.clients", page: "vpn", item: (i) => `/settings/vpn/${i}` },
  { path: "vpn.remote_access", page: "vpn" },
  { path: "vpn.sites.peers", page: "vpn", item: (i) => `/settings/vpn/sites/${i}` },
  { path: "vpn.sites", page: "vpn", item: () => "/settings/vpn/sites" },
  { path: "vpn.providers", page: "vpn", item: (i) => `/settings/vpn/providers/${i}` },
  { path: "vpn", page: "vpn" },
  { path: "hardware", page: "hardware", item: (i) => `/settings/hardware/${i}` },
];

/** The page, and the URL, where the setting at `path` is edited. */
/** Whether `path` is the setting at `pattern` or within it; a `*` in the pattern stands for any one part. */
const within = (path: string, pattern: string) => {
  const [parts, wanted] = [path.split("."), pattern.split(".")];
  return parts.length >= wanted.length && wanted.every((part, i) => part === "*" || part === parts[i]);
};

export const whereIs = (path: string) => {
  const home = settingPages.find((s) => within(path, s.path));
  if (!home) return undefined;
  const index = path.split(".")[home.path.split(".").length];
  return {
    page: home.page,
    // A fixed address (a tab), else a list item by its index, else the page.
    url: home.url ?? (home.item && index ? home.item(index) : `/settings/${home.page}`),
  };
};
