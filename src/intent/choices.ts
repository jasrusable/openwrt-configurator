// What a setting may be set to, given the rest of the intent: one rule per
// constraint, each saying why a value is not available. The schema reports
// a value a rule refuses, with the rule's own words; the UI's fields look
// up the rules for their path and grey the value out, with the same words
// in a tooltip. Where refusing would leave no way forward (a network needs
// exactly one router), choosing the value instead swaps: it also changes
// what else it must, so the settings never pass through a broken state.
// Free-text values (an address, a name) are checked by the schema alone.
import { internet } from "./firewall";
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

const bandLabels: Record<Band, string> = { "2g": "2.4 GHz", "5g": "5 GHz", "6g": "6 GHz" };

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
          hardware: next.hardware.map((d, j) =>
            j === Number(i) ? { ...d, role: "router" } : j === current ? { ...d, role: "access-point" } : d
          ),
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
    path: "radios.*.width",
    values: ["80", "160"],
    unavailable: (_, [band]) => band === "2g" && "2.4 GHz is at most 40 MHz wide.",
  },
  {
    // Off would leave an SSID that only uses this band broadcasting nowhere.
    path: "radios.*.enabled",
    values: [false],
    unavailable: (intent, [band]) => {
      const stranded = intent.wifi.find(
        (w) => w.bands && !w.bands.some((b) => b !== band && intent.radios[b]?.enabled)
      );
      return (
        stranded &&
        `“${stranded.ssid || "Unnamed"}” is only on ${bandLabels[band as Band]}: give it another band first (${where("ssids")}).`
      );
    },
    refuses: false,
  },
  {
    path: "wifi.*.bands",
    values: ["2g", "5g", "6g"],
    unavailable: (intent, _, band) =>
      !intent.radios[band as Band]?.enabled &&
      `${bandLabels[band as Band]} radios are off (${where("radios")}).`,
    // The schema reports an SSID none of whose bands is on.
    refuses: false,
  },
  {
    path: "wifi.*.extra_passwords",
    unavailable: (intent, [i]) =>
      intent.wifi[Number(i)]?.security !== "wpa2" &&
      "Only with WPA2: WPA3 has one password per network.",
  },
  {
    path: "wifi.*.security",
    values: ["wpa2-wpa3", "wpa3"],
    unavailable: (intent, [i]) =>
      !!intent.wifi[Number(i)]?.extra_passwords?.length &&
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
    unavailable: (intent) => !networkIpv6Applies(intent.internet.ipv6) && `Turn on IPv6 under ${where("internet")} first.`,
    // Ignored without the internet's IPv6, and kept for when it is back.
    refuses: false,
  },
  {
    path: "networks.*.ipv6",
    values: [true],
    unavailable: (intent, [i]) => {
      const prefix = intent.internet.ipv6_prefix;
      if (!intent.internet.ipv6 || prefix === "auto") return undefined;
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
    path: "internet.ipv6_prefix",
    values: ["48", "56", "60", "64"],
    unavailable: (intent, _, prefix) => {
      const want = intent.networks.filter((n) => n.ipv6).length;
      const room = roomIn(prefix as string);
      return (
        intent.internet.ipv6 &&
        want > room &&
        `${want} networks have IPv6, and a /${prefix} has room for ${room}.`
      );
    },
  },
  {
    path: "dns.upstream.type",
    values: ["provider"],
    unavailable: (intent) =>
      intent.internet.connection.type === "static" &&
      !intent.internet.connection.dns?.length &&
      `Your internet connection is set by hand, without DNS servers: add them under ${where("internet")} first.`,
    // Reported at the connection's DNS servers, where they are missing.
    refuses: false,
  },
  {
    // usteer moves devices between access points and between bands on one.
    path: "roaming.steering",
    values: ["nudge", "push"],
    unavailable: (intent) =>
      intent.hardware.filter((d) => d.role === "access-point").length <= 1 &&
      (["2g", "5g", "6g"] as Band[]).filter((b) => intent.radios[b]?.enabled).length <= 1 &&
      "One access point with one band on: there is nowhere to steer a device to.",
    // Harmless: with nowhere to go, nothing is steered.
    refuses: false,
  },
  {
    // Off stops usteer and turns neighbour lists off on every SSID.
    path: "wifi.*.roaming_assistance",
    unavailable: (intent) =>
      intent.roaming?.steering === "off" &&
      `Steering is ${steeringLabels.off} (${where("roaming")}): no SSID gives neighbour lists.`,
    // Ignored meanwhile, and kept for when steering is back on.
    refuses: false,
  },
  {
    path: "roaming.prefer_5g",
    values: [true],
    unavailable: (intent) =>
      intent.roaming?.steering === "off" &&
      `Steering is ${steeringLabels.off}: usteer, which moves devices between bands, is stopped.`,
    refuses: false,
  },
  {
    path: "roaming.prefer_5g",
    values: [true],
    unavailable: (intent) =>
      !(intent.radios["2g"]?.enabled && (intent.radios["5g"]?.enabled || intent.radios["6g"]?.enabled)) &&
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
    path: "firewall.rules.*.destination_port",
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
        const keys = part === "*" ? Object.keys(value) : [part];
        return keys
          .filter((key) => key in value)
          .map((key) => ({
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

/** The rules for one setting, by its path (like "radios.2g.width"), given the rest of the intent. */
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
