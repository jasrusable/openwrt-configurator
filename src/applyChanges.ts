// Why each change an apply makes on a device is there, and what it is called,
// so the Apply page can group them: your edits, an app update (this app now
// writes something else for the same settings), a fix (src/intent/patches),
// or a change made on the device by hand that applying replaces.
//
// Three things decide it, per `uci show` line: what the device holds now,
// what the apply leaves, and what the settings last applied leave when
// compiled today. Where the last applied settings already leave what this
// apply does, the difference is not an edit: it is either the app writing
// something new, or the device having changed since. The stamp the last apply
// left (each line's sha256, never a value) tells those apart; without one (a
// device last applied before stamps existed) they are told apart as one.
import { z } from "zod";
import { appliesTo, deviceLookup } from "./plan/device";
import type { DeviceSchema } from "./deviceSchema";
import type { Origin, Plan, PlanDevice } from "./plan/types";
import { sanitizeName } from "./engine/values";
import type { OpenWrtState } from "./engine/openWrtState";
import { describePath } from "./intent/diff";
import type { Line } from "./deviceState";
import { stateLayout, StoreKey } from "./store";

export type ChangeWhy =
  /** The settings changed since the last apply. */
  | "edit"
  /** The same settings, written differently by this version of the app. */
  | "update"
  /** A fix over stock OpenWrt comes or goes (src/intent/patches). */
  | "fix"
  /** Changed on the device since the last apply, by hand or by another tool: applying replaces it. */
  | "device"
  /** An update or a change on the device: no stamp of the last apply to tell which. */
  | "unknown"
  /** Nothing was applied from these settings yet: everything is written. */
  | "first";

/**
 * What the last apply left on a device, as hashes. Secret options are left
 * out altogether: a hash of a Wi-Fi password is something to test guesses
 * against, so a change to one is told apart by the settings alone.
 */
export type AppliedStamp = {
  lines: Record<string, string>;
  files: Record<string, string>;
  packages: { add: string[]; remove: string[] };
};

const stampSchema: z.ZodType<AppliedStamp> = z.object({
  lines: z.record(z.string(), z.string()),
  files: z.record(z.string(), z.string()),
  packages: z.object({ add: z.array(z.string()), remove: z.array(z.string()) }),
});

/** Where a device's stamp is kept: one file each, by hostname (a validated name). */
export const appliedKey = (intentPath: string, hostname: string): StoreKey<AppliedStamp> => ({
  path: `${stateLayout(intentPath).applied}/${hostname}.json`,
  schema: stampSchema,
  format: 1,
});

/** A file as the apply writes it, hashed: a final newline added where there is none. */
export const writtenHash = (sha256: (text: string) => string, content: string) =>
  sha256(content.endsWith("\n") ? content : `${content}\n`);

/** The stamp of a device's state, from its declared lines (as `uciLines` gives them). */
export const stampOf = (lines: Map<string, Line>, state: OpenWrtState, sha256: (text: string) => string): AppliedStamp => ({
  lines: Object.fromEntries([...lines].filter(([, line]) => !line.secret).map(([key, line]) => [key, sha256(line.value)])),
  files: Object.fromEntries(state.files.map((f) => [f.path, writtenHash(sha256, f.content)])),
  packages: { add: [...state.packages.add].sort(), remove: [...state.packages.remove].sort() },
});

/** What the settings last applied leave on the device, compiled today; absent when nothing was applied yet. */
export type Last = { lines: Map<string, Line>; state: OpenWrtState } | undefined;

type Context = {
  last: Last;
  stamp?: AppliedStamp;
  sha256: (text: string) => string;
};

/** Why one `uci show` line changes, from what the device holds (`now`) to what the apply leaves (`after`). */
export const lineWhy = (
  key: string,
  now: Line | undefined,
  after: Line | undefined,
  fix: string | undefined,
  { last, stamp, sha256 }: Context
): ChangeWhy => {
  if (fix) return "fix";
  if (!last) return "first";
  if (last.lines.get(key)?.value !== after?.value) return "edit";
  if (!stamp || (now ?? after)?.secret) return "unknown";
  const was = stamp.lines[key];
  // Applied last time, and the device still holds it: the app writes it differently now.
  if (was !== undefined) return now !== undefined && sha256(now.value) === was ? "update" : "device";
  // Not applied last time: something the device grew since, or the app now adds.
  return now !== undefined ? "device" : "update";
};

/** Why a section shows under a new name: the device holds it as `from`, the apply as `to`. */
export const renameWhy = (from: string, to: string, { last, stamp }: Context): ChangeWhy => {
  if (!last) return "first";
  if (!last.lines.has(to)) return "edit";
  if (!stamp) return "unknown";
  return to in stamp.lines ? "device" : from in stamp.lines ? "update" : "unknown";
};

/** Why a package is installed (`added`) or removed. */
export const packageWhy = (pkg: string, added: boolean, fix: string | undefined, { last, stamp }: Context): ChangeWhy => {
  if (fix) return "fix";
  if (!last) return "first";
  const list = (state: { packages: { add: string[]; remove: string[] } }) => (added ? state.packages.add : state.packages.remove);
  if (!list(last.state).includes(pkg)) return "edit";
  if (!stamp) return "unknown";
  // Wanted last time too: the device lost it (or got it back) since.
  return list(stamp).includes(pkg) ? "device" : "update";
};

/** Why a managed file is written (`content`) or removed (none). */
export const fileWhy = (
  path: string,
  content: string | undefined,
  nowHash: string | undefined,
  fix: string | undefined,
  { last, stamp, sha256 }: Context
): ChangeWhy => {
  if (fix) return "fix";
  if (!last) return "first";
  const lastFile = last.state.files.find((f) => f.path === path);
  if (lastFile?.content !== content) return "edit";
  if (!stamp) return "unknown";
  const was = stamp.files[path];
  if (was === undefined) return content === undefined ? "device" : "update";
  return nowHash === was ? "update" : "device";
};

/** What each kind of section is, in people's terms, where its origin does not say. */
const typeLabels: Record<string, string> = {
  "system.system": "System",
  "system.timeserver": "Time server",
  "network.interface": "Network interface",
  "network.device": "Network device",
  "network.bridge-vlan": "VLAN on the bridge",
  "network.switch": "Switch",
  "network.switch_vlan": "Switch VLAN",
  "network.rule": "Routing rule",
  "network.route": "Route",
  "network.globals": "Network settings",
  "firewall.defaults": "Firewall defaults",
  "firewall.zone": "Firewall zone",
  "firewall.forwarding": "Firewall forwarding",
  "firewall.rule": "Firewall rule",
  "firewall.redirect": "Port forward",
  "firewall.include": "Firewall script",
  "dhcp.dnsmasq": "DNS server",
  "dhcp.dhcp": "DHCP",
  "dhcp.odhcpd": "IPv6 DHCP and router adverts",
  "dhcp.host": "Address reservation",
  "dhcp.domain": "DNS host",
  "wireless.wifi-device": "Radio",
  "wireless.wifi-iface": "Wi-Fi network",
  "wireless.wifi-station": "Wi-Fi password",
  "dropbear.dropbear": "SSH server",
  "uhttpd.uhttpd": "Web server",
  "uhttpd.cert": "Web server certificate",
  "https-dns-proxy.https-dns-proxy": "Encrypted DNS resolver",
  "https-dns-proxy.main": "Encrypted DNS",
  "upnpd.upnpd": "UPnP",
  "umdns.umdns": "Device names (mDNS)",
  "usteer.usteer": "Roaming assistance",
  "sqm.queue": "Smart queueing",
  "ddns.service": "Dynamic DNS",
  "mwan3.interface": "Internet line monitoring",
  "mwan3.member": "Internet line use",
  "mwan3.policy": "Internet line policy",
  "mwan3.rule": "Internet line rule",
};

/** Each config's name in people's terms, where its section type is not listed above. */
const configLabels: Record<string, string> = {
  system: "System",
  network: "Network",
  firewall: "Firewall",
  dhcp: "DNS and DHCP",
  wireless: "Wi-Fi",
  dropbear: "SSH",
  uhttpd: "Web server",
  "https-dns-proxy": "Encrypted DNS",
  upnpd: "UPnP",
  umdns: "Device names (mDNS)",
  usteer: "Roaming assistance",
  sqm: "Smart queueing",
  ddns: "Dynamic DNS",
  mwan3: "Internet lines",
  nlbwmon: "Traffic counting",
  avahi: "Device discovery",
  avahi_daemon: "Device discovery",
  ubihealthd: "Flash health",
  luci: "LuCI",
  rpcd: "LuCI sessions",
};

/** A config's name in people's terms. */
export const configLabel = (config: string) => configLabels[config] ?? config;

/** Where each section a device gets came from, by its `uci show` key; Wi-Fi networks by their name's prefix (one per radio). */
export type Origins = { exact: Map<string, Origin & { type: string }>; prefixed: [string, Origin & { type: string }][] };

/**
 * The origins of a device's sections, named as the engine names them: by
 * their own name, else their type and place among those that apply; a
 * Wi-Fi network once per radio, its name then prefixed.
 */
export const originsOf = (plan: Plan, device: PlanDevice, schema: DeviceSchema): Origins => {
  const lookup = deviceLookup(device, schema);
  const entries = Object.entries(plan.config).flatMap(([configKey, types]) =>
    Object.entries(types).flatMap(([type, sections]) =>
      sections
        .filter((s) => appliesTo(s.when, lookup))
        .map((s, index) => {
          const name = (s.overrides ?? []).filter((o) => appliesTo(o.when, lookup)).reduce<string | undefined>((n, o) => o.name ?? n, s.name);
          const perRadio = configKey === "wireless" && type === "wifi-iface" && name !== undefined;
          return { key: perRadio ? `${configKey}.${name}_` : `${configKey}.${name ?? sanitizeName(`${type}${index}`)}`, perRadio, origin: { ...(s.origin ?? {}), type } };
        })
    )
  );
  return {
    exact: new Map(entries.filter((e) => !e.perRadio).map((e) => [e.key, e.origin])),
    prefixed: entries.filter((e) => e.perRadio).map((e) => [e.key, e.origin]),
  };
};

/** A line's section key (`config.section`) and option, if it has one. */
const parts = (key: string) => {
  const [config, section, ...rest] = key.split(".");
  return { config, sectionKey: `${config}.${section}`, section, option: rest.join(".") || undefined };
};

const originAt = (origins: Origins, sectionKey: string) =>
  origins.exact.get(sectionKey) ?? origins.prefixed.find(([prefix]) => sectionKey.startsWith(prefix))?.[1];

/** What one line is about, for people: its name, what it is for, and the setting or item it comes from. */
export type Described = { label: string; about?: string; setting?: string; item?: string };

/** A `uci show` line's name in people's terms, from where it came from in the settings. */
export const describeLine = (key: string, origins: Origins | undefined, intent: unknown): Described => {
  const { config, sectionKey, section, option } = parts(key);
  const origin = origins && originAt(origins, sectionKey);
  const setting = option ? origin?.settings?.[option] : undefined;
  const named = (path: string) => describePath(path.split("."), intent).join(" › ");
  const kind = origin ? (typeLabels[`${config}.${origin.type}`] ?? configLabel(config)) : configLabel(config);
  const label = setting
    ? named(setting)
    : origin?.item
      ? `${named(origin.item) || kind}${option ? ` › ${option}` : ""}`
      : `${kind} “${section}”${option ? ` › ${option}` : ""}`;
  return {
    label: label || key,
    ...(origin?.why ? { about: origin.why } : {}),
    ...(setting ? { setting } : {}),
    ...(origin?.item ? { item: origin.item } : {}),
  };
};
