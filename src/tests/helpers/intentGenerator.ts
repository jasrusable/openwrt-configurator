// Valid intents, many of them, deterministic from a seed: the sample, then
// random sequences of the edits the app itself allows. The rules' own options
// and swaps (choices.ts), the cross-setting edits (edits.ts), and items added
// and removed as the UI's lists make them. An edit whose result the schema
// refuses is skipped, so every intent returned is one a user could save.
import type { PathsOf } from "../../intent/paths";
import { availability, choices } from "../../intent/choices";
import { withNetworkAdded, withoutLine, withoutNetwork, withoutProvider } from "../../intent/edits";
import { networkTemplates, templateSettings, withTemplate } from "../../intent/networks";
import { Intent, intentSchema } from "../../intent/schema";
import { newPrivateKey, publicKeyOf } from "../../wireguard";
import { sampleIntentJson } from "./fixtures";

/** mulberry32: small, fast, and the same everywhere. */
export const prng = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

type Random = ReturnType<typeof prng>;
const pick = <T>(random: Random, items: readonly T[]): T | undefined =>
  items.length ? items[Math.floor(random() * items.length)] : undefined;
const int = (random: Random, low: number, high: number) => low + Math.floor(random() * (high - low + 1));

/** Keys made by the app (a swap's new WireGuard or mesh key) come from the seed too, so a case can be made again. */
const withSeededCrypto = <T>(random: Random, run: () => T): T => {
  const crypto = globalThis.crypto;
  const seeded = {
    ...crypto,
    getRandomValues: <A extends ArrayBufferView | null>(array: A): A => {
      if (array) new Uint8Array(array.buffer, array.byteOffset, array.byteLength).forEach((_, i, bytes) => (bytes[i] = Math.floor(random() * 256)));
      return array;
    },
  };
  Object.defineProperty(globalThis, "crypto", { value: seeded, configurable: true });
  try {
    return run();
  } finally {
    Object.defineProperty(globalThis, "crypto", { value: crypto, configurable: true });
  }
};

const setIn = (value: any, path: string[], next: unknown): any =>
  path.length === 0
    ? next
    : Array.isArray(value)
      ? value.map((v, i) => (String(i) === path[0] ? setIn(v, path.slice(1), next) : v))
      : { ...value, [path[0]]: setIn(value?.[path[0]], path.slice(1), next) };
const getIn = (value: any, path: string[]) => path.reduce((v, k) => v?.[k], value);

/** Every concrete place a rule's path matches in `intent`. */
const placesOf = (intent: Intent, pattern: string): string[][] => {
  const parts = pattern.split(".");
  const expand = (value: any, i: number, path: string[]): string[][] =>
    i === parts.length
      ? [path]
      : value === null || typeof value !== "object"
        ? []
        : (parts[i] === "*" ? Object.keys(value) : [parts[i]]).filter((k) => k in value).flatMap((k) => expand(value[k], i + 1, [...path, k]));
  return expand(intent, 0, []);
};

/** A line's settings for a type, the rest of it kept, as the UI's type switch does. */
const lineOfType = (line: any, type: string) => {
  const { pppoe, static: fixed, ...rest } = line;
  return type === "pppoe"
    ? { ...rest, type, pppoe: { username: "user", password: "secret" } }
    : type === "static"
      ? { ...rest, type, static: { address: "198.51.100.10", prefix_length: 24, gateway: "198.51.100.1", dns: ["9.9.9.9"] } }
      : { ...rest, type };
};

/** Port names routers commonly have, for lines beyond the first. */
export const linePorts = ["eth1", "eth2", "lan2", "lan3", "lan4"] as const;

/** Settings the rules do not enumerate, with values to try (the rules still have their say). */
const plainSettings: [string, unknown[]][] = [
  ["internet.lines.*.type", ["dhcp", "pppoe", "static"]],
  ["internet.lines.*.ipv6.enabled", [true, false]],
  ["internet.lines.*.shaping", [undefined, { down_mbps: 100, up_mbps: 20, medium: "ethernet" }]],
  ["internet.use_lines.mode", ["failover", "balance"]],
  ["internet.use_lines.sticky_per_device", [true, false]],
  ["internet.upnp", [true, false]],
  ["networks.*.ipv6", [true, false]],
  ["networks.*.access.internet", [true, false]],
  ["networks.*.access.via", [undefined, "wan", "wanb", "tun1"]],
  ["wifi.networks.*.enabled", [true, false]],
  ["wifi.networks.*.bands", [undefined, ["2g"], ["5g"], ["2g", "5g"]]],
  ["firewall.port_forwards.*.enabled", [true, false]],
  ["dns.rebind_protection", [true, false]],
  ["hardware.*.uplink", ["cable", "mesh"]],
];

const plainEdit = (intent: Intent, random: Random): Intent | undefined => {
  const [pattern, values] = pick(random, plainSettings)!;
  const path = pick(random, placesOf(intent, pattern.split(".").slice(0, -1).join(".")))?.concat(pattern.split(".").slice(-1));
  if (!path) return undefined;
  const value = pick(random, values);
  if (value !== undefined && availability(intent, path.join(".") as PathsOf<Intent>).option(value).unavailable) return undefined;
  if (path[path.length - 1] === "type") return setIn(intent, path.slice(0, -1), lineOfType(getIn(intent, path.slice(0, -1)), String(value)));
  return setIn(intent, path, value);
};

/** A rule's value, or what its swap makes: as choices.test applies them. */
const choiceEdit = (intent: Intent, random: Random): Intent | undefined => {
  const choice = pick(random, choices.filter((c) => c.values?.length));
  const path = choice && pick(random, placesOf(intent, choice.path));
  // Any rule's values: as loose as the rule the pick could be.
  const value = choice && pick<unknown>(random, choice.values ?? []);
  if (!path || value === undefined) return undefined;
  const option = availability(intent, path.join(".") as PathsOf<Intent>).option(value);
  if (option.unavailable) return undefined;
  const current = getIn(intent, path);
  if (option.swap) return option.swap.apply(intent);
  if (Array.isArray(current)) {
    return setIn(intent, path, current.includes(value) ? current.filter((v) => v !== value) : [...current, value]);
  }
  if (path[path.length - 1] === "type" && path[0] === "internet") {
    return setIn(intent, path.slice(0, -1), lineOfType(getIn(intent, path.slice(0, -1)), String(value)));
  }
  return setIn(intent, path, value);
};

const freeId = (prefix: string, used: string[], from = 1) => {
  for (let n = from; ; n++) if (!used.includes(`${prefix}${n}`)) return `${prefix}${n}`;
};

/** A network as the Networks page adds one: next VLAN and range, a template's access. */
const addNetwork = (intent: Intent, random: Random): Intent => {
  const vlan = [10, 20, 30, 40, 50, 60, 70, 80].find((v) => !intent.networks.some((n) => n.vlan === v));
  if (vlan === undefined) return intent;
  const template = pick(random, networkTemplates)!;
  const settings = templateSettings(template, []);
  const network = {
    id: freeId("net", intent.networks.map((n) => n.id), 2),
    name: `Net ${vlan}`,
    vlan,
    subnet: `10.0.${vlan + 100}.0/24`,
    ipv6: random() < 0.5,
    dhcp: { pool_size: 100, lease: "12h", reservations: [] },
    ...settings,
    access: { ...settings.access, fallback: true },
  };
  const added = { ...intent, networks: [...intent.networks, network] } as Intent;
  return withTemplate(withNetworkAdded(added, added.networks.length - 1), added.networks.length - 1, template);
};

const addLine = (intent: Intent, random: Random): Intent => {
  const ids = ["wanb", "wanc", "wand"].filter((id) => !intent.internet.lines.some((l) => l.id === id));
  if (!ids.length) return intent;
  const line = {
    id: ids[0],
    name: `Line ${ids[0]}`,
    type: "dhcp",
    // A named port, as a user picks one from the router's: a board without it is skipped by the tests.
    port: pick(random, linePorts),
    ...(random() < 0.3 ? { vlan: int(random, 100, 200) } : {}),
    ipv6: { enabled: false, prefix: "auto" },
    failover: { weight: int(random, 1, 3), metered: random() < 0.3, down_when_slow: random() < 0.3 },
  };
  return { ...intent, internet: { ...intent.internet, lines: [...intent.internet.lines, line] } } as Intent;
};

const addSsid = (intent: Intent, random: Random): Intent => {
  const n = intent.wifi.networks.length + 1;
  const ssid = {
    // Now and then a name that reads like a placeholder in the low-level
    // JSON: it must stay the text it is, there and back.
    ssid: random() < 0.15 ? `${pick(random, ["@wan_port", "@@x", "*", "*t", "@cpu_port.1", "@best/80", "@bridge_ports"])} ${n}`.trim().replace(/ \d+$/, "") : `Net ${n}`,
    enabled: true,
    security: pick(random, ["wpa2-wpa3", "wpa3", "wpa2"] as const),
    password: `password-${n}-long`,
    network: pick(random, intent.networks)!.id,
    hidden: random() < 0.2,
    isolate_clients: random() < 0.5,
    roaming: { fast: random() < 0.5, assisted: random() < 0.5 },
  };
  return { ...intent, wifi: { ...intent.wifi, networks: [...intent.wifi.networks, ssid] } } as Intent;
};

const addRule = (intent: Intent, random: Random): Intent => {
  const ends = [...intent.networks.map((n) => n.id), "internet", "*"];
  const rule = {
    name: `Rule ${intent.firewall.rules.length + 1}`,
    enabled: random() < 0.8,
    from: pick(random, ends)!,
    to: pick(random, [...intent.networks.map((n) => n.id), "router", "internet", "*"])!,
    protocol: pick(random, ["tcp", "udp", "tcp+udp", "icmp", "any"] as const),
    action: pick(random, ["allow", "block"] as const),
    ...(random() < 0.5 ? { ports: pick(random, ["22", "80 443", "1000-2000"]) } : {}),
  };
  return { ...intent, firewall: { ...intent.firewall, rules: [...intent.firewall.rules, rule] } } as Intent;
};

const addPortForward = (intent: Intent, random: Random): Intent => {
  const network = pick(random, intent.networks)!;
  const base = network.subnet.split("/")[0].split(".").slice(0, 3).join(".");
  const forward = {
    name: `Forward ${intent.firewall.port_forwards.length + 1}`,
    enabled: true,
    protocol: pick(random, ["tcp", "udp", "tcp+udp"] as const),
    port: String(int(random, 1024, 60000)),
    to: { address: `${base}.${int(random, 10, 99)}` },
    reflection: random() < 0.5,
  };
  return { ...intent, firewall: { ...intent.firewall, port_forwards: [...intent.firewall.port_forwards, forward] } } as Intent;
};

const addAccessPoint = (intent: Intent, random: Random): Intent => {
  const name = freeId("ap-", intent.hardware.map((h) => h.name), 2);
  return { ...intent, hardware: [...intent.hardware, { name, role: "access-point", uplink: random() < 0.3 ? "mesh" : "cable" }] } as Intent;
};

const addProvider = (intent: Intent, random: Random): Intent => {
  const id = ["tun1", "tun2", "tun3"].find((t) => !intent.vpn.providers.some((p) => p.id === t));
  if (!id) return intent;
  const provider = {
    id,
    name: `Provider ${id}`,
    type: "wireguard",
    private_key: newPrivateKey(),
    address: `10.64.${int(random, 1, 200)}.2/32`,
    dns: ["10.64.0.1"],
    peer: { public_key: publicKeyOf(newPrivateKey()), endpoint: "203.0.113.5:51820" },
  };
  return { ...intent, vpn: { ...intent.vpn, providers: [...intent.vpn.providers, provider] } } as Intent;
};

const addClient = (intent: Intent, random: Random): Intent => {
  const clients = intent.vpn.remote_access.clients;
  const client = {
    id: freeId("c", clients.map((c) => c.id)),
    name: `Phone ${clients.length + 1}`,
    public_key: publicKeyOf(newPrivateKey()),
    host: clients.length + 2,
    route: pick(random, ["home", "all"] as const),
  };
  return setIn(intent, ["vpn", "remote_access", "clients"], [...clients, client]);
};

const addSite = (intent: Intent, random: Random): Intent => {
  const peers = intent.vpn.sites.peers;
  const n = peers.length + 1;
  const peer = { id: `s${n}`, name: `Site ${n}`, public_key: publicKeyOf(newPrivateKey()), subnets: [`172.16.${n}.0/24`] };
  const sites = { ...intent.vpn.sites, private_key: intent.vpn.sites.private_key ?? newPrivateKey(), peers: [...peers, peer] };
  return setIn(intent, ["vpn", "sites"], sites);
};

const removeAt = <T>(items: T[], index: number) => items.filter((_, i) => i !== index);

/** Each edit, weighted by how often it is drawn. */
const edits: [number, (intent: Intent, random: Random) => Intent | undefined][] = [
  [10, choiceEdit],
  [6, plainEdit],
  [2, addNetwork],
  [1, (i, r) => (i.networks.length > 1 ? withoutNetwork(i, int(r, 1, i.networks.length - 1)) : undefined)],
  [1, addLine],
  [1, (i, r) => (i.internet.lines.length > 1 ? withoutLine(i, int(r, 1, i.internet.lines.length - 1)) : undefined)],
  [2, addSsid],
  [1, (i, r) => (i.wifi.networks.length ? { ...i, wifi: { ...i.wifi, networks: removeAt(i.wifi.networks, int(r, 0, i.wifi.networks.length - 1)) } } : undefined)],
  [2, addRule],
  [2, addPortForward],
  [1, addAccessPoint],
  [1, (i, r) => {
    const aps = i.hardware.flatMap((h, n) => (h.role === "access-point" ? [n] : []));
    return aps.length ? { ...i, hardware: removeAt(i.hardware, pick(r, aps)!) } : undefined;
  }],
  [1, addProvider],
  [1, (i, r) => (i.vpn.providers.length ? withoutProvider(i, int(r, 0, i.vpn.providers.length - 1)) : undefined)],
  [1, addClient],
  [1, addSite],
];
const totalWeight = edits.reduce((sum, [w]) => sum + w, 0);
const drawEdit = (random: Random) => {
  let at = random() * totalWeight;
  return edits.find(([w]) => (at -= w) < 0)![1];
};

const valid = (intent: unknown): Intent | undefined => {
  const parsed = intentSchema.safeParse(intent);
  return parsed.success ? parsed.data : undefined;
};

/** One intent: the sample after up to `steps` edits that each leave it valid. */
export const generateIntent = (seed: number, steps = 12): Intent => {
  const random = prng(seed);
  return withSeededCrypto(random, () => {
    let intent = valid(sampleIntentJson())!;
    const count = int(random, 1, steps);
    for (let i = 0; i < count * 3 && i < 60; i++) {
      try {
        const next = drawEdit(random)(intent, random);
        const checked = next && valid(next);
        if (checked) intent = checked;
      } catch {
        // An edit that does not apply here (a rule's path missing, say): the next one.
      }
    }
    return intent;
  });
};

/** `count` intents from `seed`: the same ones every time. */
export const generateIntents = (count: number, seed = 1) =>
  Array.from({ length: count }, (_, i) => generateIntent(seed * 100_003 + i));
