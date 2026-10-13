// Which page shows each setting, kept apart from the pages themselves so
// anything (the problems list, a removal's consequences) can use it.
/**
 * Which page shows each setting, by the start of its path; for a list, the
 * URL of one item's page. The problems list and the sidebar's marks use it.
 */
export const settingPages: { path: string; page: string; item?: (index: string) => string }[] = [
  { path: "system", page: "system" },
  { path: "internet.lines", page: "internet", item: (i) => `/internet/${i}` },
  { path: "internet", page: "internet" },
  { path: "firewall.rules", page: "firewall", item: (i) => `/firewall/rules/${i}` },
  { path: "firewall.port_forwards", page: "firewall", item: (i) => `/firewall/${i}` },
  { path: "firewall", page: "firewall" },
  { path: "networks", page: "networks", item: (i) => `/networks/${i}` },
  { path: "wifi.networks", page: "wifi", item: (i) => `/wifi/${i}` },
  { path: "wifi.radios", page: "wifi", item: (band) => `/wifi/radios/${band}` },
  { path: "wifi.roaming", page: "wifi", item: () => "/wifi/roaming" },
  { path: "wifi.mesh", page: "wifi", item: () => "/wifi/mesh" },
  { path: "wifi", page: "wifi" },
  { path: "dns", page: "dns" },
  // Most specific first: the first whose path starts the setting's is its page.
  { path: "vpn.remote_access.clients", page: "vpn", item: (i) => `/vpn/${i}` },
  { path: "vpn.remote_access", page: "vpn" },
  { path: "vpn.sites.peers", page: "vpn", item: (i) => `/vpn/sites/${i}` },
  { path: "vpn.sites", page: "vpn", item: () => "/vpn/sites" },
  { path: "vpn.providers", page: "vpn", item: (i) => `/vpn/providers/${i}` },
  { path: "vpn", page: "vpn" },
  { path: "hardware", page: "hardware", item: (i) => `/hardware/${i}` },
];

/** The page, and the URL, where the setting at `path` is edited. */
export const whereIs = (path: string) => {
  const home = settingPages.find((s) => path === s.path || path.startsWith(`${s.path}.`));
  if (!home) return undefined;
  const index = path.slice(home.path.length + 1).split(".")[0];
  return {
    page: home.page,
    // A list item by its index; a radio by its band.
    url: home.item && index ? home.item(index) : `/${home.page}`,
  };
};
