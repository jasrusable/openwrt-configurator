// What a setting may be set to, given the rest of the intent: one rule per
// constraint, each saying why a value is not available. The schema reports
// a value a rule refuses, with the rule's own words; the UI's fields look
// up the rules for their path and grey the value out, with the same words
// in a tooltip. Where refusing would leave no way forward (a network needs
// exactly one router), choosing the value instead swaps: it also changes
// what else it must, so the settings never pass through a broken state.
// Free-text values (an address, a name) are checked by the schema alone.
import { internetIpv6, multiWan, primaryConnection } from "./connections";
import { internet } from "./firewall";
import { newPrivateKey } from "../wireguard";
import { where } from "./places";
import { steeringLabels } from "./roaming";
import type { Band, Intent } from "./schema";

type Networks = Pick<Intent["networks"][number], "id" | "vlan">[];

/** The main network: the one untagged network, which devices are managed over. */
export const isMainNetwork = (networks: Networks, index: number) =>
  networks.filter((n) => n.vlan === undefined).length === 1 &&
  networks[index]?.vlan === undefined;

/** The networks network `index` may be given access to: every other one. */
export const reachableNetworks = (networks: Networks, index: number) =>
  networks.filter((_, i) => i !== index).map((n) => n.id);

/** A network's IPv6 applies only with the internet's: alone it would be local-only. */
export const networkIpv6Applies = (internetIpv6: boolean) => internetIpv6;

/** Ports only mean something for TCP and UDP. */
export const portsApply = (protocol: string | undefined) =>
  ["tcp+udp", "tcp", "udp"].includes(protocol ?? "tcp+udp");

export const channelWidths = ["auto", "20", "40", "80", "160"] as const;

/** The VLAN that carries the mesh over cables (wifi.mesh.over_cable): no network may use it. */
export const meshWiredVlan = 4000;

/** The bands a mesh can use, and their channels no radar (DFS) can move it off. */
export const meshBands = ["2g", "5g", "6g"] as const;
type MeshBand = (typeof meshBands)[number];
export const meshChannels: Record<MeshBand, number[]> = {
  "2g": [1, 6, 11],
  "5g": [36, 40, 44, 48],
  // 6 GHz has no radar channels: its preferred (PSC) ones, which devices scan first.
  "6g": [37, 53, 69, 85],
};

const bandLabels: Record<Band, string> = { "2g": "2.4 GHz", "5g": "5 GHz", "6g": "6 GHz" };

/** A mesh key: 32 random letters and digits, from the platform's strong random source. */
export const newMeshKey = () => {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
};

/** How many /64s a delegated prefix of this length holds. */
const roomIn = (prefix: string) => 2 ** (64 - Number(prefix));

type Reason = string | false | undefined | null | 0;

export type Swap = {
  /** What else changes, for the option's tooltip. */
  note: string;
  /** The intent with the value chosen and the rest changed to fit. */
  apply: (intent: Intent) => Intent;
};

export type Choice = {
  /** The setting, as in fields.ts: each * matches a list index or a key (a band). */
  path: string;
  /** The values it is about; unset, the setting as a whole (in use when set, true or non-empty). */
  values?: readonly unknown[];
  /** Why not, given the rest; nothing when allowed. `at` holds what each * matched. */
  unavailable?: (intent: Intent, at: string[], value: unknown) => Reason;
  /**
   * Whether the schema refuses it too. False where the value is harmless
   * (ignored while unavailable) or another rule reports the same problem:
   * the UI still greys it out.
   */
  refuses?: boolean;
  /** Instead of refusing, choosing it also changes the rest to fit. */
  swap?: (intent: Intent, at: string[], value: unknown) => Swap | undefined;
};

export const choices: Choice[] = [
  {
    // Making another device the router hands the role over.
    path: "hardware.*.role",
    values: ["router"],
    swap: (intent, [i]) => {
      const current = intent.hardware.findIndex((d, j) => d.role === "router" && j !== Number(i));
      if (current < 0) return undefined;
      return {
        note: `${intent.hardware[current].name || "The current router"} becomes an access point.`,
        apply: (next) => ({
          ...next,
          hardware: next.hardware.map((d, j) => {
            // The router is cabled: a mesh uplink it had as an access point goes.
            return j === Number(i)
              ? { ...d, role: "router", uplink: "cable" }
              : j === current
                ? { ...d, role: "access-point" }
                : d;
          }),
        }),
      };
    },
  },
  {
    path: "hardware.*.role",
    values: ["access-point"],
    unavailable: (intent, [i]) =>
      intent.hardware[Number(i)]?.role === "router" &&
      (intent.hardware.length > 1
        ? "A network has one router: choose Router on the device that should take over, and this one becomes an access point."
        : "A network needs a router."),
    // The schema's "exactly one router" says it for a hand-edited file.
    refuses: false,
  },
  {
    path: "wifi.radios.*.width",
    values: ["80", "160"],
    unavailable: (_, [band]) => band === "2g" && "2.4 GHz is at most 40 MHz wide.",
  },
  {
    // 160 MHz on 5 GHz spans 36 to 64, radar channels among them: a radar
    // would move the access point off the mesh's channel.
    path: "wifi.radios.*.width",
    values: ["160"],
    unavailable: (intent, [band]) =>
      intent.wifi.mesh?.enabled &&
      intent.wifi.mesh.band === band &&
      band === "5g" &&
      `The mesh keeps to channels without radar (${where("mesh")}): 80 MHz at most.`,
    // Capped at 80 by the compiler meanwhile.
    refuses: false,
  },
  {
    // Off would leave an SSID that only uses this band broadcasting nowhere.
    path: "wifi.radios.*.enabled",
    values: [false],
    unavailable: (intent, [band]) => {
      const stranded = intent.wifi.networks.find(
        (w) => w.bands && !w.bands.some((b) => b !== band && intent.wifi.radios[b]?.enabled)
      );
      return (
        stranded &&
        `“${stranded.ssid || "Unnamed"}” is only on ${bandLabels[band as Band]}: give it another band first (${where("ssids")}).`
      );
    },
    refuses: false,
  },
  {
    path: "wifi.networks.*.bands",
    values: ["2g", "5g", "6g"],
    unavailable: (intent, _, band) =>
      !intent.wifi.radios[band as Band]?.enabled &&
      `${bandLabels[band as Band]} radios are off (${where("radios")}).`,
    // The schema reports an SSID none of whose bands is on.
    refuses: false,
  },
  {
    path: "wifi.networks.*.extra_passwords",
    unavailable: (intent, [i]) =>
      intent.wifi.networks[Number(i)]?.security !== "wpa2" &&
      "Only with WPA2: WPA3 has one password per network.",
  },
  {
    path: "wifi.networks.*.security",
    values: ["wpa2-wpa3", "wpa3"],
    unavailable: (intent, [i]) =>
      !!intent.wifi.networks[Number(i)]?.extra_passwords?.length &&
      "It has more passwords, which only WPA2 allows: remove them first.",
    // The extra passwords' own rule reports it.
    refuses: false,
  },
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
      !networkIpv6Applies(internetIpv6(intent)) &&
      `Turn on IPv6 for ${primaryConnection(intent).name || "the main connection"} under ${where("internet")} first.`,
    // Ignored without the internet's IPv6, and kept for when it is back.
    refuses: false,
  },
  {
    path: "networks.*.ipv6",
    values: [true],
    unavailable: (intent, [i]) => {
      const prefix = primaryConnection(intent).ipv6.prefix;
      if (!internetIpv6(intent) || prefix === "auto") return undefined;
      const others = intent.networks.filter((n, j) => n.ipv6 && j !== Number(i)).length;
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
    path: "internet.lines.*.ipv6.prefix",
    values: ["48", "56", "60", "64"],
    unavailable: (intent, [c], prefix) => {
      const want = intent.networks.filter((n) => n.ipv6).length;
      const room = roomIn(prefix as string);
      return (
        c === "0" &&
        internetIpv6(intent) &&
        want > room &&
        `${want} networks have IPv6, and a /${prefix} has room for ${room}.`
      );
    },
  },
  {
    path: "dns.upstream.type",
    values: ["provider"],
    unavailable: (intent) => {
      const bare = intent.internet.lines.find((l) => l.type === "static" && !l.static.dns?.length);
      return (
        bare &&
        `${bare.name || "An internet line"} is set by hand, without DNS servers: add them under ${where("internet")} first.`
      );
    },
    // Reported at the line's DNS servers, where they are missing.
    refuses: false,
  },
  {
    // The networks' IPv6 comes from the main line alone: two providers'
    // prefixes at once leave clients on a dead one when a line fails.
    path: "internet.lines.*.ipv6.enabled",
    unavailable: (intent, [c]) =>
      c !== "0" && `Your networks get IPv6 from the first line, ${primaryConnection(intent).name || "the main one"}.`,
    refuses: false,
  },
  {
    path: "internet.lines.*.ipv6.prefix",
    unavailable: (intent, [c]) => c !== "0" && "Only the first line's prefix is used.",
    refuses: false,
  },
  {
    // A port carries one line: reported at the later of two (the UI greys
    // a port any other line uses, with portTakenBy). Unset (the router's
    // WAN port) is checked by the schema.
    path: "internet.lines.*.port",
    unavailable: (intent, [c], port) => {
      const other = intent.internet.lines.slice(0, Number(c)).find((o) => o.port === port);
      return port !== undefined && other && `${other.name || "Another line"} uses it.`;
    },
  },
  {
    // Unset is the router's WAN port, which one line can have: the earliest
    // that has it keeps it.
    path: "internet.lines.*.port",
    values: [undefined],
    unavailable: (intent, [c]) => {
      const other = intent.internet.lines.slice(0, Number(c)).find((o) => o.port === undefined);
      return other && `${other.name || "Another line"} uses the WAN port.`;
    },
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
    // A provider's tunnel never falls back (features/vpn.ts): the kill switch, always.
    path: "networks.*.access.fallback",
    values: [true],
    unavailable: (intent, [i]) => {
      const tunnel = intent.vpn.providers?.find((t) => t.id === intent.networks[Number(i)]?.access.via);
      return tunnel && `Never through a VPN provider: the plain line would leak what ${tunnel.name} hides.`;
    },
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
  {
    // Turning it on makes the router's key, and lets clients reach the main network.
    path: "vpn.remote_access.enabled",
    values: [true],
    swap: (intent) =>
      intent.vpn.remote_access.private_key
        ? undefined
        : {
            note: "Makes the router's WireGuard key.",
            apply: (next) => {
              const remote = next.vpn.remote_access;
              return {
                ...next,
                vpn: {
                  ...next.vpn,
                  remote_access: {
                    ...remote,
                    enabled: true,
                    private_key: newPrivateKey(),
                    access: remote.access.networks.length
                      ? remote.access
                      : { ...remote.access, networks: next.networks.filter((n) => n.vlan === undefined).map((n) => n.id) },
                  },
                },
              };
            },
          },
  },
  {
    path: "internet.lines.*.failover.metered",
    unavailable: (intent) => !multiWan(intent) && "With one line it is used for everything anyway.",
    refuses: false,
  },
  {
    path: "internet.lines.*.failover.down_when_slow",
    unavailable: (intent) => !multiWan(intent) && "With one line there is nothing to switch to.",
    refuses: false,
  },
  {
    path: "internet.use_lines.sticky_per_device",
    unavailable: (intent) =>
      (!multiWan(intent) || intent.internet.use_lines.mode !== "balance") && "Only used when lines share traffic.",
    refuses: false,
  },
  {
    path: "internet.use_lines.mode",
    unavailable: (intent) => !multiWan(intent) && "With one line there is nothing to share or fail over to.",
    refuses: false,
  },
  {
    path: "internet.lines.*.failover.weight",
    unavailable: (intent) =>
      (!multiWan(intent) || intent.internet.use_lines.mode !== "balance") && "Only used when lines share traffic.",
    refuses: false,
  },
  {
    // The mesh carries everything between its nodes on one radio band.
    path: "wifi.mesh.enabled",
    values: [true],
    unavailable: (intent) =>
      !intent.wifi.radios[intent.wifi.mesh.band]?.enabled &&
      `The ${bandLabels[intent.wifi.mesh.band]} radios are off (${where("radios")}).`,
    // Turning it on makes its key: every node must have the same, and nobody types it.
    swap: (intent) =>
      intent.wifi.mesh.key
        ? undefined
        : {
            note: "Makes a key the access points share.",
            apply: (next) => ({ ...next, wifi: { ...next.wifi, mesh: { ...next.wifi.mesh, enabled: true, key: newMeshKey() } } }),
          },
  },
  {
    path: "wifi.mesh.band",
    values: [...meshBands],
    unavailable: (intent, _, band) =>
      intent.wifi.mesh.enabled && !intent.wifi.radios[band as Band]?.enabled && `The ${bandLabels[band as Band]} radios are off.`,
    // Each band has its own channels: the channel moves with it.
    swap: (intent, _, band) => {
      const channels = meshChannels[band as MeshBand];
      return channels.includes(intent.wifi.mesh.channel)
        ? undefined
        : {
            note: `Moves the mesh to channel ${channels[0]}.`,
            apply: (next) => ({ ...next, wifi: { ...next.wifi, mesh: { ...next.wifi.mesh, band: band as MeshBand, channel: channels[0] } } }),
          };
    },
  },
  {
    path: "wifi.radios.*.enabled",
    values: [false],
    unavailable: (intent, [band]) =>
      intent.wifi.mesh.enabled &&
      intent.wifi.mesh.band === band &&
      `The mesh links your access points on this band (${where("mesh")}): turn it off, or move it, first.`,
  },
  {
    // An SSID only on the mesh's band would be broadcast nowhere.
    path: "wifi.mesh.band_reserved",
    values: [true],
    unavailable: (intent) => {
      const only = intent.wifi.networks.find((w) => w.bands?.length && w.bands.every((b) => b === intent.wifi.mesh.band));
      return only && `“${only.ssid || "An SSID"}” only uses this band (${where("ssids")}).`;
    },
  },
  {
    // Only over cables: the Wi-Fi links always take them.
    path: "wifi.mesh.large_frames",
    unavailable: (intent) => !intent.wifi.mesh?.over_cable && "Only for the mesh over cables.",
    refuses: false,
  },
  {
    path: "hardware.*.uplink",
    values: ["mesh"],
    unavailable: (intent, [i]) =>
      intent.hardware[Number(i)]?.role === "router" && "The router is where the network starts: it is cabled.",
  },
  {
    // Kept for when the mesh is back; until then every device is cabled (features/devices.ts).
    path: "hardware.*.uplink",
    values: ["mesh"],
    unavailable: (intent) => !intent.wifi.mesh.enabled && `Turn on the mesh first (${where("mesh")}).`,
    refuses: false,
  },
  // Every mesh node is on the mesh's channel: one access point elsewhere would drop out of it.
  ...(["2g", "5g"] as const).map(
    (band): Choice => ({
      path: `hardware.*.radios.${band}.channel`,
      unavailable: (intent) =>
        intent.wifi.mesh.enabled && band === intent.wifi.mesh.band && `Set by the mesh (${where("mesh")}): every node uses its channel.`,
      refuses: false,
    })
  ),
  {
    path: "system.ssh.password_login",
    values: [false],
    unavailable: (intent) =>
      !intent.system.ssh?.authorized_keys?.length &&
      "Add an authorized key first: with neither a password nor a key, nobody could log in.",
  },
  {
    // usteer moves devices between access points and between bands on one.
    path: "wifi.roaming.steering",
    values: ["nudge", "push"],
    unavailable: (intent) =>
      intent.hardware.filter((d) => d.role === "access-point").length <= 1 &&
      (["2g", "5g", "6g"] as Band[]).filter((b) => intent.wifi.radios[b]?.enabled).length <= 1 &&
      "One access point with one band on: there is nowhere to steer a device to.",
    // Harmless: with nowhere to go, nothing is steered.
    refuses: false,
  },
  {
    // Off stops usteer and turns neighbour lists off on every SSID.
    path: "wifi.networks.*.roaming.assisted",
    unavailable: (intent) =>
      intent.wifi.roaming?.steering === "off" &&
      `Steering is ${steeringLabels.off} (${where("roaming")}): no SSID gives neighbour lists.`,
    // Ignored meanwhile, and kept for when steering is back on.
    refuses: false,
  },
  {
    path: "wifi.roaming.prefer_5g",
    values: [true],
    unavailable: (intent) =>
      intent.wifi.roaming?.steering === "off" &&
      `Steering is ${steeringLabels.off}: usteer, which moves devices between bands, is stopped.`,
    refuses: false,
  },
  {
    path: "wifi.roaming.prefer_5g",
    values: [true],
    unavailable: (intent) =>
      !(intent.wifi.radios["2g"]?.enabled && (intent.wifi.radios["5g"]?.enabled || intent.wifi.radios["6g"]?.enabled)) &&
      `Needs 2.4 GHz and a faster band on (${where("radios")}).`,
    refuses: false,
  },
  {
    path: "firewall.rules.*.to",
    values: [internet],
    unavailable: (intent, [i]) =>
      intent.firewall.rules[Number(i)]?.from === internet &&
      "Traffic from the internet to the internet never passes the router.",
  },
  {
    path: "firewall.rules.*.from",
    values: [internet],
    unavailable: (intent, [i]) =>
      intent.firewall.rules[Number(i)]?.to === internet &&
      "Traffic from the internet to the internet never passes the router.",
    refuses: false,
  },
  {
    path: "firewall.rules.*.ports",
    unavailable: (intent, [i]) =>
      !portsApply(intent.firewall.rules[Number(i)]?.protocol) && "Ports only apply to TCP and UDP.",
    // Ignored for other protocols, and kept for when it is TCP or UDP again.
    refuses: false,
  },
];

/** Whether a setting is used: set, and not off or empty. */
export const inUse = (value: unknown) =>
  value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);

/** Whether a setting holds a value: equal to it, or containing it (a list). */
const holds = (value: unknown, option: unknown) =>
  Array.isArray(value) ? value.includes(option) : value === option;

/** Every place a rule's path matches in the intent: its path, what each * matched, its value. */
const expand = (intent: unknown, pattern: string) =>
  pattern.split(".").reduce<{ path: string[]; at: string[]; value: unknown }[]>(
    (places, part) =>
      places.flatMap(({ path, at, value }) => {
        if (value === null || typeof value !== "object") return [];
        // A named key that is missing still has a place, holding undefined:
        // a rule about the unset value (the WAN port) applies there too.
        const keys = part === "*" ? Object.keys(value) : [part];
        return keys.map((key) => ({
            path: [...path, key],
            at: part === "*" ? [...at, key] : at,
            value: (value as Record<string, unknown>)[key],
          }));
      }),
    [{ path: [], at: [], value: intent }]
  );

const reasonOf = (reason: Reason) => (reason ? reason : undefined);

/** What the rules refuse in an intent, for the schema to report. */
export const choiceIssues = (intent: Intent) =>
  choices
    .filter((choice) => choice.unavailable && choice.refuses !== false)
    .flatMap((choice) =>
      expand(intent, choice.path).flatMap(({ path, at, value }) => {
        const used = choice.values ? choice.values.filter((v) => holds(value, v)) : inUse(value) ? [value] : [];
        const reason = used.map((v) => reasonOf(choice.unavailable!(intent, at, v))).find(Boolean);
        return reason ? [{ path: path.map((p) => (/^\d+$/.test(p) ? Number(p) : p)), message: reason }] : [];
      })
    );

/** What the * parts of `pattern` match in `path`, or undefined if it does not match. */
const matchPath = (pattern: string, path: string) => {
  const parts = pattern.split(".");
  const segments = path.split(".");
  if (parts.length !== segments.length) return undefined;
  const at: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "*") at.push(segments[i]);
    else if (parts[i] !== segments[i]) return undefined;
  }
  return at;
};

export type Availability = {
  /** Why the setting as a whole is not available, if it is not, and whether the schema refuses it. */
  unavailable?: { reason: string; refuses: boolean };
  /** For one value: why it is not available, or what choosing it also changes. */
  option: (value: unknown) => { unavailable?: string; swap?: Swap };
};

/** The rules for one setting, by its path (like "wifi.radios.2g.width"), given the rest of the intent. */
export const availability = (intent: Intent, path: string): Availability => {
  const rules = choices.flatMap((choice) => {
    const at = matchPath(choice.path, path);
    return at ? [{ choice, at }] : [];
  });
  return {
    unavailable: rules
      .filter(({ choice }) => !choice.values && choice.unavailable)
      .map(({ choice, at }) => {
        const reason = reasonOf(choice.unavailable!(intent, at, undefined));
        return reason ? { reason, refuses: choice.refuses !== false } : undefined;
      })
      .find(Boolean),
    option: (value) => {
      const about = rules.filter(({ choice }) => choice.values?.includes(value));
      return {
        unavailable: about
          .filter(({ choice }) => choice.unavailable)
          .map(({ choice, at }) => reasonOf(choice.unavailable!(intent, at, value)))
          .find(Boolean),
        swap: about.map(({ choice, at }) => choice.swap?.(intent, at, value)).find(Boolean),
      };
    },
  };
};

/** Whether a setting may hold a value, as the rules see it. */
export const allowed = (intent: Intent, path: string, value: unknown) => {
  const rules = availability(intent, path);
  return !(inUse(value) && rules.unavailable) && !rules.option(value).unavailable;
};
