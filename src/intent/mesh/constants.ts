// The mesh's numbers and names, written once: the compiler writes them
// (compile.ts), the explainers quote them (fields.ts), status and the UI
// read them.
import { fnv, siteSeed } from "../site";
import type { Intent } from "../schema";

/** batman-adv's header, on top of a 1500-byte frame: the mesh link's MTU. */
export const meshMtu = 1532;

/** batman's cost of each hop, twice its default: a hop on one radio halves the speed, so prefer fewer. */
export const meshHopPenalty = 30;

/**
 * Weakest signal a mesh link may form at, dBm: a node does not pair with one
 * fainter (a flaky long hop batman would then route over). Stellenberg took 0
 * (no limit); -80 is the usual guidance for a usable 802.11s link.
 */
export const meshRssiThreshold = -80;

/**
 * batman-adv's routing: V chooses paths by each link's measured throughput
 * (ELP), where IV judges only by lost packets; better over mixed links (2.4 and
 * 5 GHz, cables). Stellenberg ran IV.
 */
export const meshRouting = "BATMAN_V";

/** The mesh's interface on each node: fixed, so its MTU can be set by name. */
export const meshInterface = "mesh0";

/** The mesh's name on the air, from the site: the same on every node, never typed. */
export const meshId = (intent: Pick<Intent, "system">) => `onc-${fnv(`${siteSeed(intent)}/mesh`)}`;

/**
 * A repeater's rescue network: the address it has there, link-local and from
 * its name, so a laptop that got no address from DHCP (169.254.x.y, on its
 * own) reaches it with nothing else set up.
 */
export const rescueAddress = (name: string) => {
  const hash = fnv(`${name}/rescue`);
  return `169.254.${1 + (parseInt(hash.slice(0, 2), 16) % 254)}.${1 + (parseInt(hash.slice(2, 4), 16) % 254)}`;
};

/** Its rescue SSID: "<name> rescue", at most 32 characters. */
export const rescueSsid = (name: string) => `${name.slice(0, 25)} rescue`;

/** Minutes without hearing another node before the rescue network comes up. */
export const rescueAfterMinutes = 3;
