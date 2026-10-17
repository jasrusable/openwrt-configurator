// What a network may be, given the rest: the main one keeps full router
// access, IPv6 needs the internet's (and room in its prefix), and a line to
// keep to needs internet access and somewhere else to go.
import type { Choice } from "../feature";
import { internetIpv6, multiWan, networkHasIpv6, primaryConnection, roomIn } from "../connections";
import { isMain } from "../fragment";
import { where } from "../places";
import type { Intent } from "../schema";

type Networks = Pick<Intent["networks"][number], "id" | "vlan">[];

/** The main network: the one untagged network, which devices are managed over. */
const isMainNetwork = (networks: Networks, index: number) =>
  networks.filter(isMain).length === 1 && !!networks[index] && isMain(networks[index]);

/** The networks network `index` may be given access to: every other one. */
export const reachableNetworks = (networks: Networks, index: number) =>
  networks.filter((_, i) => i !== index).map((n) => n.id);

export const networksRules: Choice[] = [
  {
    path: "networks.*.access.router",
    values: ["services"],
    unavailable: (intent, [i]) =>
      isMainNetwork(intent.networks, Number(i)) &&
      "The main network manages the router and access points: it keeps full access.",
  },
  {
    path: "networks.*.ipv6",
    unavailable: (intent) =>
      !internetIpv6(intent) &&
      `Turn on IPv6 for ${primaryConnection(intent).name || "the main connection"} under ${where("internet")} first.`,
    // Ignored without the internet's IPv6, and kept for when it is back.
    refuses: false,
  },
  {
    path: "networks.*.ipv6",
    values: [true],
    unavailable: (intent, [i]) => {
      const prefix = primaryConnection(intent).ipv6.prefix;
      const network = intent.networks[Number(i)];
      // Only networks that get IPv6 take a /64: not one kept to another line or a tunnel.
      // One already on stays free to turn off: over the room, the prefix's rule refuses.
      if (prefix === "auto" || !network || network.ipv6 || !networkHasIpv6(intent, { ...network, ipv6: true })) return undefined;
      const others = intent.networks.filter((n, j) => j !== Number(i) && networkHasIpv6(intent, n)).length;
      const room = roomIn(prefix);
      return (
        others + 1 > room &&
        `The internet's /${prefix} prefix has room for ${room} network${room === 1 ? "" : "s"} with IPv6: ask for a larger one (${where("internet", "IPv6 prefix size")}).`
      );
    },
    // The prefix's own rule reports it.
    refuses: false,
  },
  {
    // Ignored with one line; kept for when there are several again.
    path: "networks.*.access.via",
    unavailable: (intent, [i]) =>
      (intent.networks[Number(i)]?.access?.internet === false && "This network has no internet access.") ||
      (!multiWan(intent) &&
        !intent.vpn.providers?.length &&
        `With one internet line and no VPN provider (${where("vpnProviders")}), every network uses it.`),
    refuses: false,
  },
  {
    // A network out through a provider's tunnel: its IPv6 would go around it.
    path: "networks.*.ipv6",
    values: [true],
    unavailable: (intent, [i]) => {
      const via = intent.networks[Number(i)]?.access.via;
      const tunnel = intent.vpn.providers?.find((t) => t.id === via);
      const line = intent.internet.lines.find((c, j) => j > 0 && c.id === via);
      return (
        (tunnel && `It goes out through ${tunnel.name}: IPv6 would go around the tunnel.`) ||
        (line && `It keeps to ${line.name || "a backup line"}: IPv6 only goes out the main line.`)
      );
    },
    refuses: false,
  },
];
