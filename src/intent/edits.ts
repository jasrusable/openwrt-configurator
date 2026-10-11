// Edits that span settings, as pure functions of the intent: the UI applies
// them, and the tests check them without a browser.
import { Intent } from "./schema";

/** After adding network `index`: home networks may reach it, as they reach the rest. */
export const withNetworkAdded = (intent: Intent, index: number): Intent => {
  const id = intent.networks[index].id;
  return {
    ...intent,
    networks: intent.networks.map((network, i) =>
      i !== index && network.purpose === "home" && !network.access.networks.includes(id)
        ? { ...network, access: { ...network.access, networks: [...network.access.networks, id] } }
        : network
    ),
  };
};

/**
 * Remove network `index`, and every trace of it: no network reaches it any
 * more, and the rules and port forwards that name it go with it.
 */
export const withoutNetwork = (intent: Intent, index: number): Intent => {
  const { id, subnet } = intent.networks[index];
  const prefix = subnet.split(".").slice(0, 3).join(".") + ".";
  return {
    ...intent,
    networks: intent.networks
      .filter((_, i) => i !== index)
      .map((network) => ({
        ...network,
        access: { ...network.access, networks: network.access.networks.filter((n) => n !== id) },
      })),
    firewall: {
      ...intent.firewall,
      rules: intent.firewall.rules.filter((r) => r.from !== id && r.to !== id),
      port_forwards: intent.firewall.port_forwards.filter(
        (f) => !f.internal_address.startsWith(prefix)
      ),
    },
  };
};
