// Which page shows each setting, kept apart from the pages themselves so
// anything (the problems list, a removal's consequences) can use it.
/**
 * Which page shows each setting, by the start of its path; for a list, the
 * URL of one item's page. The problems list and the sidebar's marks use it.
 */
export const settingPages: { path: string; page: string; item?: (index: string) => string }[] = [
  { path: "site", page: "general" },
  { path: "admin", page: "general" },
  { path: "internet", page: "internet" },
  { path: "firewall.rules", page: "firewall", item: (i) => `/firewall/rules/${i}` },
  { path: "firewall.port_forwards", page: "firewall", item: (i) => `/firewall/${i}` },
  { path: "networks", page: "networks", item: (i) => `/networks/${i}` },
  { path: "wifi", page: "ssids", item: (i) => `/ssids/${i}` },
  { path: "radios", page: "radios", item: (band) => `/radios/${band}` },
  { path: "dns", page: "dns" },
  { path: "devices", page: "devices", item: (i) => `/devices/${i}` },
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
