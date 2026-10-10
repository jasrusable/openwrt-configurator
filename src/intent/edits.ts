// Edits that span settings, as pure functions of the intent: the UI applies
// them, and the tests check them without a browser.
import { zoneForPurpose } from "./firewall";
import { Intent } from "./schema";

/**
 * After adding network `index`: if it is in no zone yet, give it its own,
 * set up from its purpose (trusted zones also reach every other zone).
 */
export const withNetworkZone = (intent: Intent, index: number): Intent => {
  const network = intent.networks[index];
  const { zones, forwardings } = intent.firewall;
  if (zones.some((z) => z.networks.includes(network.id))) return intent;
  const id = zones.some((z) => z.id === network.id)
    ? `${network.id}z`
    : network.id;
  const created = zoneForPurpose(network.purpose, {
    id,
    network: network.id,
    otherZones: zones.map((z) => z.id),
  });
  // Trusted zones (those accepting input, like Home) reach the new one too.
  const fromTrusted = zones
    .filter((z) => z.input === "accept")
    .map((z) => ({ from: z.id, to: id }));
  return {
    ...intent,
    firewall: {
      ...intent.firewall,
      zones: [...zones, created.zone],
      forwardings: [...forwardings, ...created.forwardings, ...fromTrusted],
    },
  };
};

/**
 * Remove network `index`, and its trace in the firewall: it leaves its zone,
 * and a zone left with no networks goes, with the forwardings that name it.
 * Rules naming it stay, flagged, for the user to decide.
 */
export const withoutNetwork = (intent: Intent, index: number): Intent => {
  const id = intent.networks[index].id;
  const zones = intent.firewall.zones.map((z) => ({
    ...z,
    networks: z.networks.filter((n) => n !== id),
  }));
  const gone = zones.filter((z) => z.networks.length === 0).map((z) => z.id);
  return {
    ...intent,
    networks: intent.networks.filter((_, i) => i !== index),
    firewall: {
      ...intent.firewall,
      zones: zones.filter((z) => !gone.includes(z.id)),
      forwardings: intent.firewall.forwardings.filter(
        (f) => !gone.includes(f.from) && !gone.includes(f.to)
      ),
    },
  };
};

/** Move network `id` into zone `zoneId` (out of whichever it was in). */
export const withNetworkInZone = (intent: Intent, id: string, zoneId: string): Intent => ({
  ...intent,
  firewall: {
    ...intent.firewall,
    zones: intent.firewall.zones.map((z) => ({
      ...z,
      networks:
        z.id === zoneId
          ? [...new Set([...z.networks, id])]
          : z.networks.filter((n) => n !== id),
    })),
  },
});
