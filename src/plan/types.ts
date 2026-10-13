// The plan: what the compiler produces and the engine applies. Everything
// device-specific is left open, as a condition (`When`) or a placeholder
// the engine fits to the device's facts; nothing here is a string to parse.
// A hand-written low-level config is read into the same shape
// (src/lowLevel/).
import { When } from "./when";

/** A value the engine fits to the device. */
export type Placeholder =
  /** A line's port: the board's WAN port, or one by name; its own device, or a VLAN on it. */
  | { kind: "linePort"; port?: string; vlan?: number }
  /** The switch's CPU device (a swconfig board), or a VLAN on it. */
  | { kind: "cpuPort"; vlan?: number }
  /** In a port list: every physical port nothing else uses, untagged or tagged. */
  | { kind: "freePorts"; tagged: boolean }
  /** A bridge VLAN's whole port list: every port of its bridge (the mesh's too), untagged or tagged. */
  | { kind: "bridgePorts"; tagged: boolean }
  /** A network device section's name: one such section per port of the free-port bridge. */
  | { kind: "eachBridgePort" }
  /** A Wi-Fi interface's radio: every radio the device has. */
  | { kind: "allRadios" }
  /** A radio's mode: the newest standard it supports, at the widest width up to this. */
  | { kind: "bestMode"; width: number }
  /** A Wi-Fi interface's extra passwords: a wifi-station section each, on every radio it is on. */
  | { kind: "stations"; keys: string[] };

export type Scalar = string | number | boolean;
export type Value = Scalar | Placeholder | (Scalar | Placeholder)[];
export type Options = Record<string, Value>;

/** Options merged over a section's where `when` holds (and, if given, its name). */
export type Override = { when: When; name?: string; options: Options };

/** One UCI section to declare, where `when` holds, with `overrides` merged over its options where theirs do. */
export type Section = {
  /** Its section name; unnamed, the engine names it by type and place. */
  name?: string;
  when?: When;
  options: Options;
  overrides?: Override[];
};

/** config -> section type -> sections, in the order they are declared. */
export type Sections = Record<string, Record<string, Section[]>>;

export type PlanDevice = {
  enabled?: boolean;
  /** Read from the device's board.json when absent; set, it is checked against the device. */
  modelId?: string;
  /** Only needed to provision or inspect the device over SSH. */
  ipaddr?: string;
  hostname: string;
  /** Earlier first: a device reached through another is changed before it. Default 0. */
  provisionOrder?: number;
  tags: Record<string, string | string[]>;
  /** How this app logs in to it over SSH. */
  login?: { username: string; password?: string; privateKeyPath?: string };
};

export type Service = {
  when?: When;
  name: string;
  /** It must have a running process afterwards (checked). */
  running?: boolean;
  /** false: installed but off, stopped and disabled. */
  enabled?: boolean;
  /** Restarted after a rollback restores the config (its reload keeps the devices it had). */
  restartAfterRollback?: boolean;
};

export type PlanFile = {
  when?: When;
  path: string;
  content: string;
  mode?: string;
  /** Runs as soon as the file is written, before `uci commit`. */
  runAfter?: string;
  /** Runs after the commit and reload, over a fresh session. */
  runAfterReload?: string;
};

export type Plan = {
  /** The release images are built for (build-images), per device where overrides match. */
  version?: { value: string; overrides?: { when: When; value: string }[] };
  devices: PlanDevice[];
  /** apk packages to install, and to remove. */
  packages: { when?: When; add?: string[]; remove?: string[] }[];
  services: Service[];
  files: PlanFile[];
  /** What the wipe leaves alone. */
  keep: { when?: When; entries: KeepEntry[] }[];
  config: Sections;
};

/**
 * A config the wipe leaves, whole or only its sections of a type; `optional`
 * when the device may not have it (a config a package sets up on first boot),
 * so its absence is no typo to warn about.
 */
export type KeepEntry = { config: string; type?: string; optional?: boolean };

/** A keep entry as the low-level format writes it, and messages name it: `?config.type`, `config.*`. */
export const keepText = (entry: KeepEntry) => `${entry.optional ? "?" : ""}${entry.config}.${entry.type ?? "*"}`;

/** A piece of a plan, as each compiler feature returns it. */
export type Fragment = Partial<Omit<Plan, "version">>;

/** The placeholders, as the compiler writes them. */
export const placeholder = {
  wanPort: (vlan?: number): Placeholder => ({ kind: "linePort", ...(vlan !== undefined ? { vlan } : {}) }),
  port: (port: string, vlan?: number): Placeholder => ({ kind: "linePort", port, ...(vlan !== undefined ? { vlan } : {}) }),
  cpuPort: (vlan?: number): Placeholder => ({ kind: "cpuPort", ...(vlan !== undefined ? { vlan } : {}) }),
  freePorts: { kind: "freePorts", tagged: false } satisfies Placeholder,
  freePortsTagged: { kind: "freePorts", tagged: true } satisfies Placeholder,
  bridgePorts: { kind: "bridgePorts", tagged: false } satisfies Placeholder,
  bridgePortsTagged: { kind: "bridgePorts", tagged: true } satisfies Placeholder,
  eachBridgePort: { kind: "eachBridgePort" } satisfies Placeholder,
  allRadios: { kind: "allRadios" } satisfies Placeholder,
  bestMode: (width: number): Placeholder => ({ kind: "bestMode", width }),
  stations: (keys: string[]): Placeholder => ({ kind: "stations", keys }),
};

export const isPlaceholder = (value: unknown): value is Placeholder =>
  !!value && typeof value === "object" && !Array.isArray(value) && "kind" in value;

/** A section's name, condition and overrides, as the compiler writes them before its options. */
export type SectionMeta = { name?: string; when?: When; overrides?: { when: When; name?: string; options: Record<string, Value | undefined> }[] };

/** Options as a feature writes them: one left undefined is not set (OpenWrt's default). */
const defined = (options: Record<string, Value | undefined>): Options =>
  Object.fromEntries(Object.entries(options).filter((entry): entry is [string, Value] => entry[1] !== undefined));

/** A section, as the compiler writes one: like UCI's `config <type> <name>`, what it is, then its options. */
export const section = (meta: SectionMeta, options: Record<string, Value | undefined>): Section => ({
  ...(meta.name !== undefined ? { name: meta.name } : {}),
  ...(meta.when ? { when: meta.when } : {}),
  options: defined(options),
  ...(meta.overrides?.length ? { overrides: meta.overrides.map((o) => ({ ...o, options: defined(o.options) })) } : {}),
});
