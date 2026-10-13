// Edits that span settings, as pure functions of the intent: the UI applies
// them, and the tests check them without a browser.
import { siteSeed } from "./fragment";
import { networkHolding } from "./addresses";
import { withoutConnection } from "./connections";
import { Intent } from "./schema";

/** After adding network `index`: trusted networks (full router access) may reach it, as they reach the rest. */
export const withNetworkAdded = (intent: Intent, index: number): Intent => {
  const id = intent.networks[index].id;
  return {
    ...intent,
    networks: intent.networks.map((network, i) =>
      i !== index && network.access.router === "full" && !network.access.networks.includes(id)
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
  const removed = intent.networks[index];
  const { id } = removed;
  return {
    ...intent,
    networks: intent.networks
      .filter((_, i) => i !== index)
      .map((network) => ({
        ...network,
        access: { ...network.access, networks: network.access.networks.filter((n) => n !== id) },
      })),
    // Remote access and the sites no longer reach it either.
    vpn: {
      ...intent.vpn,
      remote_access: {
        ...intent.vpn.remote_access,
        access: { ...intent.vpn.remote_access.access, networks: intent.vpn.remote_access.access.networks.filter((n) => n !== id) },
      },
      sites: { ...intent.vpn.sites, access: { ...intent.vpn.sites.access, networks: intent.vpn.sites.access.networks.filter((n) => n !== id) } },
    },
    firewall: {
      ...intent.firewall,
      rules: intent.firewall.rules.filter((r) => r.from !== id && r.to !== id),
      port_forwards: intent.firewall.port_forwards.filter((f) => !networkHolding([removed], f.to.address)),
    },
  };
};

/** Networks that kept to `via` (a line or a provider now gone) go back to Automatic, with the others as fallback. */
const releasedFrom = (networks: Intent["networks"], via: string | undefined) =>
  networks.map((network) => {
    if (via === undefined || network.access.via !== via) return network;
    const { via: _, ...access } = network.access;
    return { ...network, access: { ...access, fallback: true } };
  });

/** Remove internet line `index`; networks kept to it go back to Automatic. */
export const withoutLine = (intent: Intent, index: number): Intent => ({
  ...intent,
  internet: { ...intent.internet, lines: withoutConnection(intent.internet.lines, index) },
  networks: releasedFrom(intent.networks, intent.internet.lines[index]?.id),
});

/** Remove VPN provider `index`; networks out through it go back to Automatic. */
export const withoutProvider = (intent: Intent, index: number): Intent => ({
  ...intent,
  vpn: { ...intent.vpn, providers: intent.vpn.providers.filter((_, i) => i !== index) },
  networks: releasedFrom(intent.networks, intent.vpn.providers[index]?.id),
});

/**
 * A save that renames the site keeps what its ids grew from: the name it
 * had, unless it already keeps an older one (schema's `site_id`).
 */
export const keepSiteSeed = (saved: Intent, next: Intent): Intent =>
  next.system.site_id !== undefined || saved.system.name === next.system.name
    ? next
    : { ...next, system: { ...next.system, site_id: siteSeed(saved) } };
