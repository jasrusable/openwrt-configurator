// What a setting may be set to, given the rest of the intent: one place for
// each rule, used by the schema to refuse a value and by the UI to offer
// only what it would accept (a greyed-out option, a hidden field), so the
// two cannot drift apart.
import { internet } from "./firewall";
import type { Band, Intent } from "./schema";

type Networks = Pick<Intent["networks"][number], "id" | "vlan">[];

/** The main network: the one untagged network, which devices are managed over. */
export const isMainNetwork = (networks: Networks, index: number) =>
  networks.filter((n) => n.vlan === undefined).length === 1 &&
  networks[index]?.vlan === undefined;

/** The main network keeps full router access: SSH and the admin pages are reached over it. */
export const routerAccessAllowed = (
  networks: Networks,
  index: number,
  access: "full" | "services"
) => access === "full" || !isMainNetwork(networks, index);

/** The networks network `index` may be given access to: every other one. */
export const reachableNetworks = (networks: Networks, index: number) =>
  networks.filter((_, i) => i !== index).map((n) => n.id);

/** A network's IPv6 applies only with the internet's: alone it would be local-only. */
export const networkIpv6Applies = (internetIpv6: boolean) => internetIpv6;

/** Ports only mean something for TCP and UDP. */
export const portsApply = (protocol: string | undefined) =>
  ["tcp+udp", "tcp", "udp"].includes(protocol ?? "tcp+udp");

/** A rule from the internet to the internet never passes the router. */
export const ruleDestinationAllowed = (from: string, to: string) =>
  !(from === internet && to === internet);

export const channelWidths = ["auto", "20", "40", "80", "160"] as const;

/** 2.4 GHz is at most 40 MHz wide. */
export const widthAllowed = (band: Band, width: string) =>
  !(band === "2g" && (width === "80" || width === "160"));

/** An SSID can only be broadcast on a band whose radios are on. */
export const bandAvailable = (radios: Intent["radios"], band: Band) => radios[band].enabled;

/** Per-device passwords (several PSKs) exist only in WPA2; WPA3 (SAE) has one. */
export const extraPasswordsAllowed = (security: string) => security === "wpa2";
