// A network's settings from nothing, and back to the defaults: what "Start
// new" writes, and what System › Backup's reset puts in place of everything
// but who and where the network and its devices are. Both are only a
// starting point, checked by the review: the schema fills in every default.
import { Intent, intentVersion } from "./schema";
import { mainNetwork } from "./fragment";

/** What a new network needs to be told; the rest is defaults. */
export type StarterChoices = Pick<Intent["system"], "name" | "country" | "timezone">;

/** One line (DHCP), no Wi-Fi yet, and nothing but the main network and its router to start. */
const defaults = {
  internet: { lines: [{ id: "wan", name: "Internet", type: "dhcp" }] },
  wifi: { networks: [] },
  firewall: {},
  vpn: {},
  dns: {},
};

/**
 * A new network: the main network on OpenWrt's own 192.168.1.0/24, so the
 * router is where a stock one answers and the first apply reaches it.
 */
export const starterIntent = ({ name, country, timezone }: StarterChoices): unknown => ({
  schema: intentVersion,
  system: { name, country, timezone },
  networks: [{ id: "lan", name, subnet: "192.168.1.0/24", access: { router: "full" } }],
  hardware: [{ name: "router", role: "router" }],
  ...defaults,
});

/**
 * Defaults again, keeping what finds and logs in to the devices: the name,
 * site id (so derived ids stay), country and time zone; the devices, the
 * main network's addresses and the local domain (where each device is);
 * the mesh (how some reach the network); and the app's login and keys
 * (else the next apply would lock the app out).
 *
 * Picked, never rebuilt: a `$secret` ref in what is kept stays a ref.
 */
export const resetIntent = (intent: Intent): unknown => {
  const { name, site_id, country, timezone, app_login, ssh } = intent.system;
  const main = mainNetwork(intent);
  return {
    schema: intentVersion,
    // Unset, the name is the seed, and the name is kept.
    system: { name, ...(site_id ? { site_id } : {}), country, timezone, app_login, ssh },
    networks: [{ id: main.id, name: main.name, subnet: main.subnet, access: { router: "full" } }],
    hardware: intent.hardware,
    ...defaults,
    wifi: { ...defaults.wifi, mesh: intent.wifi.mesh },
    dns: { domain: intent.dns.domain },
  };
};
