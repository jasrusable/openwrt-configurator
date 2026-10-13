// What a config may hold, written once: checked against a plan
// (src/plan/check.ts: the compiler's, or a hand-written one's once read), a
// hand-written config's JSON (src/lowLevel/schema.ts), and each device's
// config once the engine has fitted it (`checkDeviceConfig`). Permissive
// about which options a section has (UCI has far more than any table could
// list), strict where a mistake would otherwise reach a device unnoticed:
// names uci would refuse, section types a config does not have (the wipe
// would delete the real one's sections), the values listed below, and the
// options a section cannot do without.
import { z } from "zod";
import { allHtModes, firewallProtocols, firewallTargets, icmpTypes, wifiBands, wifiTypes } from "../openWrtValues";

/** Config and section type names (dropbear, bridge-vlan) reach `uci` as unquoted words. */
export const packageNamePattern = /^[A-Za-z0-9_-]+$/;
/**
 * A section name reaches `uci batch` as an unquoted word: uci's tokenizer
 * ends one at whitespace or `#`, and uci refuses a hyphen in one (verified on
 * 25.12.5) while `uci batch` still exits 0.
 */
export const sectionNamePattern = /^[A-Za-z0-9_]+$/;
export const optionNamePattern = /^[A-Za-z0-9_]+$/;
/** apk's own name charset; in a plan's `add` or `remove` list. */
export const apkPackagePattern = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
export const servicePattern = /^[A-Za-z0-9_-]+$/;
export const fileModePattern = /^[0-7]{3,4}$/;

/** WPA-PSK passphrase (8–63) or raw 256-bit PSK (64 hex digits). */
export const wifiPsk = z
  .string()
  .refine((key) => (key.length >= 8 && key.length <= 63) || /^[0-9a-fA-F]{64}$/.test(key), {
    message: "WPA PSK must be 8-63 characters or 64 hex digits",
  });

/** A managed file's path: absolute, and one line (the device keeps them a line each: its manifest, a rollback's lists). */
export const filePathProblem = (path: string) =>
  !path.startsWith("/") ? "must be an absolute path" : /[\n\r]/.test(path) ? "a path cannot hold a line break" : undefined;

/** Each config's section types; one not listed (`zones` for `zone`) is refused. Configs not here take any. */
export const sectionTypes: Record<string, { types: string[]; pattern?: RegExp }> = {
  system: { types: ["system", "timeserver", "led", "button", "rngd"] },
  // WireGuard's peers: their type is the interface's name after "wireguard_".
  network: {
    types: ["switch", "switch_vlan", "switch_port", "device", "bridge-vlan", "interface", "rule", "rule6", "route", "route6", "globals"],
    pattern: /^wireguard_[A-Za-z0-9_]+$/,
  },
  firewall: { types: ["defaults", "zone", "forwarding", "rule", "redirect", "include", "ipset", "nat"] },
  dhcp: {
    types: ["dnsmasq", "dhcp", "odhcpd", "host", "domain", "boot", "mac", "tag", "vendorclass", "userclass", "match", "subscrid", "relay", "cname", "hostrecord", "srvhost", "mxhost", "ipset"],
  },
  wireless: { types: ["wifi-device", "wifi-iface"] },
};

export const knownSectionType = (config: string, type: string) => {
  const known = sectionTypes[config];
  return !known || known.types.includes(type) || !!known.pattern?.test(type);
};

const scalar = z.union([z.string(), z.number(), z.boolean()]);
/** Any option's value, unless a rule below says more: a plain value or a list of them. */
export const plainValue = z.union([scalar, z.array(scalar)]);

/**
 * Options whose plain values are checked, by `config.type.option`. Where a
 * placeholder may stand instead (src/plan/positions.ts), it is checked there.
 */
export const optionRules: Record<string, z.ZodTypeAny> = {
  "dhcp.dhcp.dhcpv4": z.enum(["server", "disabled"]),
  "dhcp.dhcp.dhcpv6": z.enum(["server", "hybrid", "disabled"]),
  "dhcp.dhcp.ra": z.enum(["server", "hybrid", "disabled"]),
  // 2 = always advertise router lifetime: IPv6-PD installs `default from
  // PREFIX`, which odhcpd does not treat as a default route.
  "dhcp.dhcp.ra_default": z.union([z.literal(0), z.literal(1), z.literal(2)]),
  "dhcp.dhcp.ra_flags": z.array(z.enum(["managed-config", "other-config"])),
  "dhcp.dnsmasq.add_local_fqdn": z.number().min(0).max(4),
  ...Object.fromEntries(
    ["defaults", "zone"].flatMap((type) =>
      ["input", "output", "forward"].map((option) => [`firewall.${type}.${option}`, z.enum(firewallTargets)])
    )
  ),
  "firewall.zone.network": z.array(z.string()),
  "firewall.rule.proto": z.array(z.enum(firewallProtocols)),
  "firewall.rule.icmp_type": z.array(z.enum(icmpTypes)),
  "firewall.rule.family": z.enum(["any", "ipv4", "ipv6"]),
  "firewall.rule.target": z.enum(firewallTargets),
  "firewall.rule.dest_port": z.union([z.string(), z.array(z.number())]),
  "firewall.redirect.target": z.enum(["DNAT", "SNAT"]),
  "firewall.redirect.proto": z.array(z.enum(firewallProtocols)),
  "firewall.redirect.family": z.enum(["any", "ipv4", "ipv6"]),
  "firewall.redirect.dest_port": z.string(),
  "firewall.redirect.src_dport": z.string(),
  // "none": an interface with no address, e.g. a VLAN an access point only bridges.
  "network.interface.proto": z.enum(["static", "dhcp", "dhcpv6", "pppoe", "batadv", "batadv_hardif", "wireguard", "none"]),
  "network.device.mtu": z.number().int(),
  "network.device.ports": z.array(z.string()),
  "network.bridge-vlan.vlan": z.number().int(),
  "network.bridge-vlan.ports": z.array(z.string()),
  "network.switch_vlan.vlan": z.number().int(),
  "network.switch_vlan.ports": z.union([z.string(), z.array(z.string())]),
  "wireless.wifi-device.type": z.enum(wifiTypes),
  "wireless.wifi-device.band": z.enum(wifiBands),
  "wireless.wifi-device.channel": z.union([z.literal("auto"), z.number()]),
  "wireless.wifi-device.htmode": z.enum(allHtModes),
  "wireless.wifi-iface.mode": z.enum(["ap", "mesh"]),
  "wireless.wifi-iface.device": z.union([z.string(), z.array(z.string())]),
  "wireless.wifi-iface.key": wifiPsk,
};

/**
 * Options a section of a type cannot do without, once the engine has fitted
 * a device's config: its interface's protocol, a zone's policies, a rule's
 * name and target. Checked per device (`checkDeviceConfig`), where overrides
 * have been merged and placeholders resolved.
 */
const required: Record<string, string[]> = {
  "network.interface": ["proto"],
  "network.device": ["name"],
  "network.bridge-vlan": ["device", "vlan", "ports"],
  "network.switch_vlan": ["device", "vlan", "ports"],
  "firewall.zone": ["name", "input", "output", "forward", "network"],
  "firewall.rule": ["name", "target"],
  "firewall.forwarding": ["src", "dest"],
  "firewall.redirect": ["name", "target", "src"],
  "wireless.wifi-device": ["type", "band"],
  "wireless.wifi-iface": ["device", "mode"],
};

/** Types whose every option is known: a mistyped one (`dst` for `dest`) is refused rather than ignored by fw4. */
const closed: Record<string, string[]> = {
  "firewall.forwarding": ["src", "dest", "enabled"],
  "firewall.redirect": [
    "name", "enabled", "target", "src", "src_ip", "src_dport", "proto", "dest", "dest_ip", "dest_port", "family", "reflection",
  ],
};

export type ConfigIssue = { path: (string | number)[]; message: string };

/** A value checked against its option's rule (plain values only), as issues at `path`. */
export const valueIssues = (at: string, value: unknown, path: (string | number)[]): ConfigIssue[] => {
  const result = (optionRules[at] ?? plainValue).safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => ({ path: [...path, ...issue.path], message: issue.message }));
};

/** What a device's fitted config is missing or holds that it may not, as issues. */
export const deviceConfigIssues = (config: Record<string, Record<string, Record<string, unknown>[]>>): ConfigIssue[] =>
  Object.entries(config).flatMap(([configKey, types]) =>
    Object.entries(types).flatMap(([type, sections]) =>
      sections.flatMap((section, index) => {
        const key = `${configKey}.${type}`;
        const path = [configKey, type, String(section[".name"] ?? index)];
        const missing = (required[key] ?? [])
          .filter((option) => section[option] === undefined)
          .map((option) => ({ path: [...path, option], message: `${key} needs ${option}` }));
        const unknown = closed[key]
          ? Object.keys(section)
              .filter((option) => option !== ".name" && !closed[key].includes(option))
              .map((option) => ({ path: [...path, option], message: `${key} has no option ${option}` }))
          : [];
        const values = Object.entries(section)
          .filter(([option]) => option !== ".name")
          .flatMap(([option, value]) => valueIssues(`${key}.${option}`, value, [...path, option]));
        return [...missing, ...unknown, ...values];
      })
    )
  );
