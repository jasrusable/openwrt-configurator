// What the settings' values are called, for people: one place for the words
// every page and the Overview use. Band names live with the bands (radios.ts).
import type { NetworkTemplate } from "./networks";
import type { Intent } from "./schema";
import { remoteAccessZone, sitesZone } from "./access";

export { bandLabels } from "./radios";

/** An item's name as shown: "Unnamed" while it has none. */
export const shownName = (name: string | undefined) => name || "Unnamed";

/** A list of values with their labels, as a select or segmented control takes them. */
const options = <V extends string>(labels: Record<V, string>) =>
  (Object.keys(labels) as V[]).map((value) => ({ value, label: labels[value] }));

export const lineTypeLabels: Record<Intent["internet"]["lines"][number]["type"], string> = {
  dhcp: "DHCP",
  pppoe: "PPPoE",
  static: "Static IP",
};

/** A network's type: the template it follows, or Custom (networks/templates.ts). */
export const networkTypeLabels: Record<NetworkTemplate | "custom", string> = {
  home: "Home",
  guest: "Guest",
  iot: "IoT",
  custom: "Custom",
};

export const routerAccessLabels: Record<Intent["networks"][number]["access"]["router"], string> = {
  services: "Network services",
  full: "Full",
};
export const routerAccessOptions = options(routerAccessLabels);

/** The VPN's zones, where a network's access lists them beside networks. */
export const zoneLabels: Record<string, string> = {
  [remoteAccessZone]: "Remote access clients",
  [sitesZone]: "Linked sites",
};

type Protocol = Intent["firewall"]["rules"][number]["protocol"];

export const protocolLabels: Record<Protocol, string> = {
  "tcp+udp": "TCP and UDP",
  tcp: "TCP",
  udp: "UDP",
  icmp: "ICMP",
  any: "Any",
};
/** A rule's protocols; a port forward's are only those with ports. */
export const protocolOptions = options(protocolLabels);
export const portProtocolOptions = protocolOptions.filter(
  (o): o is { value: Intent["firewall"]["port_forwards"][number]["protocol"]; label: string } =>
    ["tcp+udp", "tcp", "udp"].includes(o.value)
);
