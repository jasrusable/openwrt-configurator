// A network's settings from nothing, and back to the defaults: what "Start
// new" writes, and what System › Backup's reset puts in place of everything
// but who and where the network and its devices are. Both are only a
// starting point, checked by the review: the schema fills in every default.
import { Intent, intentVersion } from "./schema";
import { mainNetwork } from "./fragment";

/**
 * What a new network needs to be told; the rest is defaults. Root's
 * password is the user's to choose (none is made up: QuickJS has no strong
 * random source, and LuCI needs one the user knows): without it the review
 * asks for it, as the intent requires one (system/checks.ts).
 */
export type StarterChoices = Pick<Intent["system"], "name" | "country" | "timezone"> & { password?: string };

/** One line (DHCP), no Wi-Fi yet, and nothing but the main network and its router to start. */
const defaults = {
  internet: { lines: [{ id: "wan", name: "Internet", type: "dhcp" }] },
  wifi: { networks: [] },
  firewall: {},
  vpn: {},
  dns: {},
};

/**
 * A new network, with its own site id (`newSiteId`: given, so this stays
 * pure): the main network on OpenWrt's own 192.168.1.0/24, so the router is
 * where a stock one answers and the first apply reaches it.
 */
export const starterIntent = ({ name, country, timezone, password }: StarterChoices, siteId: string): unknown => ({
  schema: intentVersion,
  system: { name, site_id: siteId, country, timezone, ...(password ? { app_login: { password } } : {}) },
  networks: [{ id: "lan", name: "Main", subnet: "192.168.1.0/24", access: { router: "full" } }],
  hardware: [{ name: "router", role: "router" }],
  ...defaults,
});

/**
 * Defaults again, keeping what finds and logs in to the devices: the name,
 * site id (so derived ids stay; none is made up when unset, as the name is
 * then the seed), country and time zone; the devices, the main network's
 * addresses (its subnet and reservations) and the local domain (where each
 * device is); the mesh (how some reach the network) and its band's radios;
 * and the app's login and keys (else the next apply would lock the app out).
 */
export const resetIntent = (intent: Intent): unknown => {
  const { name, site_id, country, timezone, app_login, ssh } = intent.system;
  const main = mainNetwork(intent);
  const { mesh } = intent.wifi;
  return {
    schema: intentVersion,
    system: { name, ...(site_id ? { site_id } : {}), country, timezone, app_login, ssh },
    networks: [
      { id: main.id, name: main.name, subnet: main.subnet, dhcp: { reservations: main.dhcp.reservations }, access: { router: "full" } },
    ],
    hardware: intent.hardware,
    ...defaults,
    // The mesh's band stays on: off by default (6 GHz), the mesh could not be.
    wifi: { ...defaults.wifi, mesh, ...(mesh.enabled ? { radios: { [mesh.band]: { enabled: true } } } : {}) },
    dns: { domain: intent.dns.domain },
  };
};
