// A network's template: a starting point for its access and device sharing.
// It is not stored. Which template a network follows is read off its own
// settings, so the label never disagrees with what the network does; one
// that follows none is Custom.
import { Access } from "./firewall";
import type { Intent } from "./schema";

export const networkTemplates = ["home", "guest", "iot"] as const;
export type NetworkTemplate = (typeof networkTemplates)[number];

type Network = Intent["networks"][number];

/** What a template sets, given the other networks' ids. */
export const templateSettings = (
  template: NetworkTemplate,
  others: string[]
): { access: Access; share_devices: boolean } => {
  switch (template) {
    // Trusted: reaches everything, the router included, and shares devices.
    case "home":
      return { access: { internet: true, networks: others, router: "full" }, share_devices: true };
    // The internet and the router's services only; its devices stay its own.
    case "guest":
      return { access: { internet: true, networks: [], router: "services" }, share_devices: false };
    // As guests, but its devices (a Chromecast, a speaker) are found from home.
    case "iot":
      return { access: { internet: true, networks: [], router: "services" }, share_devices: true };
  }
};

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** The template network `index` follows, or "custom". */
/** Remote access and linked sites: reachable like networks, but no template's business. */
const vpnZoneIds = ["vpn", "sites"];

export const templateOf = (networks: Network[], index: number): NetworkTemplate | "custom" => {
  const network = networks[index];
  if (!network) return "custom";
  const others = networks.filter((_, i) => i !== index).map((n) => n.id);
  return (
    networkTemplates.find((template) => {
      const { access, share_devices } = templateSettings(template, others);
      return (
        network.access.internet === access.internet &&
        network.access.router === access.router &&
        sameSet(network.access.networks.filter((id) => !vpnZoneIds.includes(id)), access.networks) &&
        (network.share_devices ?? false) === share_devices
      );
    }) ?? "custom"
  );
};

/** Network `index` set to a template's settings. */
export const withTemplate = (intent: Intent, index: number, template: NetworkTemplate): Intent => {
  const others = intent.networks.filter((_, i) => i !== index).map((n) => n.id);
  return {
    ...intent,
    networks: intent.networks.map((network, i) => {
      if (i !== index) return network;
      const settings = templateSettings(template, others);
      // Access to remote access and sites is its own choice, kept.
      const vpn = network.access.networks.filter((id) => vpnZoneIds.includes(id));
      // Which way its internet goes (via, fallback) is not the template's either.
      return { ...network, ...settings, access: { ...network.access, ...settings.access, networks: [...settings.access.networks, ...vpn] } };
    }),
  };
};
