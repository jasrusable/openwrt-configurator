// A hand-written low-level config read into a plan: each `.if` parsed into
// a condition tree, each placeholder string into a typed placeholder, and
// a whole config's own `.if` and `.overrides` (which replace a type's whole
// section list) pushed down into its sections' conditions, so the engine
// never sees any of it as text.
import { deviceFromJson, fileFromJson, serviceFromJson } from "./names";
import { parseCondition } from "../condition";
import { When, when as w } from "../plan/when";
import { KeepEntry, Options, Placeholder, Plan, Scalar, Section, Sections, Value } from "../plan/types";
import { readText } from "./placeholders";
import { LowLevelConfig } from "./schema";

/** A `.if` read into a tree (its names checked: a typo fails as the config is read). */
const conditionOf = parseCondition;

const optionalCondition = (text: string | undefined) => (text === undefined ? undefined : conditionOf(text));

/** A value as written, its placeholders typed: what each means depends on where it is (placeholders.ts). */
const valueOf = (configKey: string, type: string, option: string, value: unknown): Value => {
  const at = `${configKey}.${type}.${option}`;
  // A Wi-Fi interface's extra passwords, [{ "key": ... }]; anything else is left for the plan check to refuse.
  if (at === "wireless.wifi-iface.stations" && Array.isArray(value) && value.every((s) => typeof s?.key === "string")) {
    return { kind: "stations", keys: value.map((s: { key: string }) => s.key) };
  }
  const read = (v: unknown, whole: boolean): Scalar | Placeholder => (typeof v === "string" ? readText(at, v, whole) : (v as Scalar));
  return Array.isArray(value) ? value.map((v) => read(v, false)) : read(value, true);
};

const optionsOf = (configKey: string, type: string, raw: Record<string, unknown>): Options =>
  Object.fromEntries(
    Object.entries(raw)
      .filter(([key]) => !key.startsWith("."))
      .map(([key, value]) => [key, valueOf(configKey, type, key, value)])
  );

type RawOverride = { ".if": string; override: { ".name"?: string } & Record<string, unknown> };
type RawSection = { ".name"?: string; ".if"?: string; ".overrides"?: RawOverride[] } & Record<string, unknown>;

const sectionOf = (configKey: string, type: string, raw: RawSection, extra: When[]): Section => {
  const own = optionalCondition(raw[".if"]);
  const condition = [...extra, ...(own ? [own] : [])];
  const overrides = (raw[".overrides"] ?? []).map((o) => ({
    when: conditionOf(o[".if"]),
    ...(o.override[".name"] !== undefined ? { name: o.override[".name"] } : {}),
    options: optionsOf(configKey, type, o.override),
  }));
  return {
    ...(raw[".name"] !== undefined ? { name: raw[".name"] } : {}),
    ...(condition.length ? { when: w.all(...condition) } : {}),
    options: optionsOf(configKey, type, raw),
    ...(overrides.length ? { overrides } : {}),
  };
};

/**
 * A config's sections, its own conditions pushed down: a config `.if` holds
 * for each of them, and an override's list for a type replaces the type's
 * list where it matches and no later override for that type does.
 */
const configSections = (configKey: string, raw: LowLevelConfig["config"][string]): Record<string, Section[]> => {
  const base = optionalCondition(raw[".if"]);
  const overrides = (raw[".overrides"] ?? []).map((o) => ({ when: conditionOf(o[".if"]), types: o.override }));
  const types = [
    ...new Set([...Object.keys(raw).filter((key) => !key.startsWith(".")), ...overrides.flatMap((o) => Object.keys(o.types))]),
  ];
  return Object.fromEntries(
    types.map((type) => {
      const replacing = overrides.map((o, index) => ({ ...o, index })).filter((o) => type in o.types);
      const unless = (from: number) => {
        const later = replacing.filter((o) => o.index >= from).map((o) => o.when);
        return later.length ? [w.not(w.any(...later))] : [];
      };
      const conditions = (...more: When[]) => [...(base ? [base] : []), ...more];
      const own = ((raw as Record<string, unknown>)[type] as RawSection[] | undefined) ?? [];
      return [
        type,
        [
          ...own.map((s) => sectionOf(configKey, type, s, conditions(...unless(0)))),
          ...replacing.flatMap((o) =>
            ((o.types[type] ?? []) as RawSection[]).map((s) => sectionOf(configKey, type, s, conditions(o.when, ...unless(o.index + 1))))
          ),
        ],
      ];
    })
  );
};

/** A keep as written: `<config>.*` or `<config>.<section type>`, "?" before one the device may lack. */
export const keepEntryOf = (text: string): KeepEntry => {
  const optional = text.startsWith("?");
  const [config, type] = text.replace(/^\?/, "").split(".");
  return { config, ...(type !== "*" ? { type } : {}), ...(optional ? { optional } : {}) };
};

const whenOf = (raw: { ".if"?: string }) => {
  const condition = optionalCondition(raw[".if"]);
  return condition ? { when: condition } : {};
};

/** A validated low-level config (lowLevelSchema) as a plan. */
export const planOfLowLevel = (config: LowLevelConfig): Plan => ({
  ...(config.version !== undefined
    ? {
        version:
          typeof config.version === "string"
            ? { value: config.version }
            : {
                value: config.version[".value"],
                ...(config.version[".overrides"]
                  ? { overrides: config.version[".overrides"].map((o) => ({ when: conditionOf(o[".if"]), value: o.override[".value"] })) }
                  : {}),
              },
      }
    : {}),
  devices: config.devices.map(deviceFromJson),
  // A leading "-" removes.
  packages: (config.package_profiles ?? []).map((p) => {
    const add = p.packages.filter((name) => !name.startsWith("-"));
    const remove = p.packages.filter((name) => name.startsWith("-")).map((name) => name.slice(1));
    return { ...whenOf(p), ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) };
  }),
  services: (config.services ?? []).map(({ ".if": _if, ...service }) => ({ ...whenOf({ ".if": _if }), ...serviceFromJson(service) })),
  files: (config.files ?? []).map(({ ".if": _if, ...file }) => ({ ...whenOf({ ".if": _if }), ...fileFromJson(file) })),
  keep: (config.configs_to_not_reset ?? []).map((k) => ({ ...whenOf(k), entries: k.configs.map(keepEntryOf) })),
  ...(config.new_configs?.length ? { newConfigs: config.new_configs } : {}),
  config: Object.fromEntries(
    Object.entries(config.config).map(([key, raw]) => [key, configSections(key, raw)])
  ) as Sections,
});
