// Where things are in the app, by name: the sidebar's pages and their tabs.
// The UI's navigation takes its labels from here, and every text that points
// somewhere (a rule's reason, a description, an explainer) is built with
// `where`, so renaming a page renames every pointer to it.
export const places = {
  overview: ["Overview"],
  clients: ["Clients"],
  devices: ["Devices"],
  performance: ["Performance"],
  activity: ["Activity"],
  system: ["System"],
  general: ["System", "General"],
  patches: ["System", "Patches"],
  firmware: ["System", "Firmware"],
  backup: ["System", "Backup"],
  internet: ["Internet"],
  networks: ["Networks"],
  wifi: ["Wi-Fi"],
  ssids: ["Wi-Fi", "SSIDs"],
  radios: ["Wi-Fi", "Radios"],
  roaming: ["Wi-Fi", "Roaming"],
  mesh: ["Wi-Fi", "Mesh"],
  firewall: ["Firewall"],
  portForwards: ["Firewall", "Port forwards"],
  vpn: ["VPN"],
  vpnRemote: ["VPN", "Remote access"],
  vpnSites: ["VPN", "Sites"],
  vpnProviders: ["VPN", "Providers"],
  rules: ["Firewall", "Rules"],
  dns: ["DNS & DHCP"],
  hardware: ["Hardware"],
} as const;

export type Place = keyof typeof places;

/** "Wi-Fi › Roaming", or deeper: where("internet", "IPv6 prefix size"). */
export const where = (place: Place, ...within: string[]) => [...places[place], ...within].join(" › ");

/** A page's or tab's own name: "Roaming". */
export const placeName = (place: Place) => places[place][places[place].length - 1];
