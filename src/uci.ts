// The device's UCI config as data: parsed from `uci export`, compared with
// what the config file declares, and turned into the exact operations that
// make one into the other.
import { OpenWrtConfig } from "./openWrtConfigSchema";

export type UciSection = {
  type: string;
  /** Absent for an anonymous section. */
  name?: string;
  options: Record<string, string | string[]>;
};

/** Sections per config, in file order. */
export type UciConfigs = Record<string, UciSection[]>;

/** A config uci could not read. Emitted by the uciConfigs probe. */
export const UNREADABLE = "__ONC_UNREADABLE__";

/**
 * Split `uci export` output into lines of words, the way uci's own tokenizer
 * does: quotes (with the `'\''` escape) can span newlines, so a multi-line
 * value is one word and a line inside it that reads `config x` is not a
 * section.
 */
const lines = (text: string) => {
  const result: string[][] = [];
  let words: string[] = [];
  let word: string | undefined;
  let quote: string | undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = undefined;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (c === "\\" && i + 1 < text.length) {
      word = (word ?? "") + text[++i];
    } else if (c === " " || c === "\t" || c === "\n") {
      if (word !== undefined) words.push(word);
      word = undefined;
      if (c === "\n") {
        if (words.length > 0) result.push(words);
        words = [];
      }
    } else {
      word = (word ?? "") + c;
    }
  }
  if (quote) throw new Error("uci export output ends inside a quoted value");
  if (word !== undefined) words.push(word);
  if (words.length > 0) result.push(words);
  return result;
};

/** Parse `uci export` output, plus the probe's unreadable-config markers. */
export const parseUciExport = (text: string) => {
  const configs: UciConfigs = {};
  const unreadable: string[] = [];
  let sections: UciSection[] | undefined;
  let section: UciSection | undefined;
  for (const [keyword, ...args] of lines(text)) {
    if (keyword === "package") {
      sections = configs[args[0]] = [];
      section = undefined;
    } else if (keyword === UNREADABLE) {
      unreadable.push(args[0]);
    } else if (keyword === "config" && sections) {
      section = { type: args[0], options: {} };
      if (args[1] !== undefined) section.name = args[1];
      sections.push(section);
    } else if (keyword === "option" && section) {
      section.options[args[0]] = args[1] ?? "";
    } else if (keyword === "list" && section) {
      const existing = section.options[args[0]];
      section.options[args[0]] = [
        ...(Array.isArray(existing) ? existing : []),
        args[1] ?? "",
      ];
    } else {
      // Values are never echoed here: they can be secrets.
      throw new Error(`Unexpected "${keyword}" line in uci export output`);
    }
  }
  return { configs, unreadable };
};

/** How a declared value reads back from uci. */
const uciString = (value: unknown) =>
  typeof value === "boolean" ? (value ? "1" : "0") : String(value);

/**
 * The declared config in the shape `uci export` reads back. Options uci
 * would not store are left out: `uci set` with an empty value deletes the
 * option, and an empty list adds nothing.
 */
export const declaredConfigs = (config: OpenWrtConfig): UciConfigs =>
  Object.fromEntries(
    Object.entries(config as Record<string, Record<string, any[]>>).map(
      ([configKey, types]) => [
        configKey,
        Object.entries(types || {}).flatMap(([type, sections]) =>
          (sections || []).map((section): UciSection => {
            const { [".name"]: name, ...rest } = section;
            const options = Object.fromEntries(
              Object.entries(rest).flatMap(
                ([key, value]): [string, string | string[]][] =>
                  Array.isArray(value)
                    ? value.length > 0
                      ? [[key, value.map(uciString)]]
                      : []
                    : value === undefined || value === null || value === ""
                      ? []
                      : [[key, uciString(value)]],
              ),
            );
            return { type, name, options };
          }),
        ),
      ],
    ),
  );

/**
 * `configs_to_not_reset` entries are `<config>.*` (keep the whole config) or
 * `<config>.<section type>` (keep every section of that type).
 */
export const isKept = (keep: string[], configKey: string, type?: string) =>
  keep.includes(`${configKey}.*`) ||
  (type !== undefined && keep.includes(`${configKey}.${type}`));

/**
 * The `uci batch` deletes that wipe the device's config, by exact section,
 * leaving only what `configs_to_not_reset` keeps. Named sections are deleted
 * by name; anonymous ones as `@type[0]`, once per section: whole types are
 * either kept or wiped, so after the named ones go, every remaining section of
 * that type is one to delete.
 */
export const wipeOperations = (current: UciConfigs, keep: string[]) =>
  Object.entries(current).flatMap(([configKey, sections]) => {
    const wiped = sections.filter(
      (section) => !isKept(keep, configKey, section.type),
    );
    return [
      ...wiped.flatMap((s) =>
        s.name !== undefined ? [`delete ${configKey}.${s.name}`] : [],
      ),
      ...wiped.flatMap((s) =>
        s.name === undefined ? [`delete ${configKey}.@${s.type}[0]`] : [],
      ),
    ];
  });

/** The configs a wipe or the declared config changes, and so must commit. */
export const changedConfigs = ({
  current,
  declared,
  keep,
}: {
  current: UciConfigs;
  declared: UciConfigs;
  keep: string[];
}) =>
  [
    ...new Set([
      ...Object.keys(current).filter((configKey) =>
        current[configKey].some((s) => !isKept(keep, configKey, s.type)),
      ),
      ...Object.keys(declared).filter(
        (configKey) => declared[configKey].length > 0,
      ),
    ]),
  ].sort();

const sameValue = (a: string | string[], b: string | string[]) =>
  Array.isArray(a) && Array.isArray(b)
    ? a.length === b.length && a.every((item, i) => item === b[i])
    : a === b;

/** Option differences, by name only: values can be secrets. */
const optionProblems = (
  where: string,
  expected: UciSection["options"],
  actual: UciSection["options"],
  { exact }: { exact: boolean },
) => [
  ...Object.keys(expected).flatMap((key) =>
    !(key in actual)
      ? [`${where}: option ${key} is missing`]
      : !sameValue(expected[key], actual[key])
        ? [`${where}: option ${key} differs`]
        : [],
  ),
  ...(exact
    ? Object.keys(actual)
        .filter((key) => !(key in expected))
        .map((key) => `${where}: unexpected option ${key}`)
    : []),
];

const label = (section: UciSection) =>
  section.name ?? `(anonymous ${section.type})`;

/**
 * Check what the device has staged against what was declared, before
 * committing. Every config not kept must hold exactly the declared sections,
 * in order, with exactly the declared options. A declared section of a kept
 * type is merged into what the device has, so only its declared options are
 * checked. Returns the problems, naming sections and options but never values.
 */
export const verifyConfigs = ({
  actual,
  declared,
  keep,
}: {
  actual: UciConfigs;
  declared: UciConfigs;
  keep: string[];
}) => {
  const configKeys = [
    ...new Set([...Object.keys(actual), ...Object.keys(declared)]),
  ].sort();
  return configKeys.flatMap((configKey) => {
    const has = actual[configKey];
    const wants = declared[configKey] || [];
    if (!has) {
      return wants.length > 0
        ? [`${configKey}: config does not exist on the device`]
        : [];
    }
    const owned = (sections: UciSection[]) =>
      sections.filter((s) => !isKept(keep, configKey, s.type));
    const [hasOwned, wantsOwned] = [owned(has), owned(wants)];
    const order = (sections: UciSection[]) =>
      sections.map((s) => `${label(s)}=${s.type}`).join(", ");
    const sectionProblems =
      order(hasOwned) !== order(wantsOwned)
        ? [
            `${configKey}: expected sections [${order(
              wantsOwned,
            )}], found [${order(hasOwned)}]`,
          ]
        : wantsOwned.flatMap((want, i) =>
            optionProblems(
              `${configKey}.${label(want)}`,
              want.options,
              hasOwned[i].options,
              { exact: true },
            ),
          );
    const mergedProblems = wants
      .filter((s) => isKept(keep, configKey, s.type))
      .flatMap((want) => {
        const found = has.find((s) => s.name === want.name);
        return found
          ? optionProblems(
              `${configKey}.${label(want)}`,
              want.options,
              found.options,
              { exact: false },
            )
          : [`${configKey}.${label(want)}: section is missing`];
      });
    return [...sectionProblems, ...mergedProblems];
  });
};

/** `configs_to_not_reset` entries naming a config the device does not have. */
export const unmatchedKeeps = (keep: string[], current: UciConfigs) =>
  keep.filter((entry) => !(entry.split(".")[0] in current));
