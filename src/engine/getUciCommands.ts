import { optionNamePattern, packageNamePattern, sectionNamePattern } from "../plan/rules";
import { isSecretOption, Redact } from "../secretOptions";
import { OpenWrtConfig, OpenWrtSection, UciScalar } from "./openWrtState";
import { shellQuote } from "../shell";

/** One uci operation as data: a section declared (its type a bare word), or an option's value. */
export type UciOperation = { op: "section"; key: string; type: string } | { op: "set" | "add_list"; key: string; value: string };

/** An operation as `uci batch` reads it: the value quoted, the rest plain words. */
export const uciLine = (o: UciOperation) => (o.op === "section" ? `set ${o.key}=${o.type}` : `${o.op} ${o.key}=${shellQuote(o.value)}`);

// Values are quoted; names cannot be, so they must already be plain words.
// The five modelled packages are schema-checked, but a passthrough one
// (dropbear, sqm, ...) reaches here unchecked; a section name with a hyphen
// uci refuses while `uci batch` still exits 0: caught here, not after packages.
const checkName = (name: string, pattern: RegExp, what: string) => {
  if (!pattern.test(name)) {
    throw new Error(
      `Invalid UCI ${what} name ${JSON.stringify(name)}: use letters, digits and _` + (pattern === packageNamePattern ? " or -" : "") + "."
    );
  }
};

/** The operations that declare a config: each section's type, then its options. */
export const uciOperations = ({
  openWrtConfig,
  redact,
}: {
  openWrtConfig: OpenWrtConfig;
  /** Replace a secret before it is quoted into the script. */
  redact?: Redact;
}): UciOperation[] => {
  // Booleans become 0/1 here. A secret by its option is one whatever its
  // type (a numeric password); by its value only an original string is, so a
  // secret whose text is "1" must not blank every flag.
  const render = (value: UciScalar, option: string) => {
    const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
    return redact && (typeof value === "string" || isSecretOption(option)) ? redact(text, { option }) : text;
  };
  const sectionOperations = (configKey: string, type: string, section: OpenWrtSection): UciOperation[] => {
    const { ".name": name, ...options } = section;
    checkName(configKey, packageNamePattern, "package");
    checkName(type, packageNamePattern, "section type");
    checkName(name, sectionNamePattern, "section");
    Object.keys(options).forEach((key) => checkName(key, optionNamePattern, "option"));
    const identifier = `${configKey}.${name}`;
    return [
      { op: "section", key: identifier, type },
      ...Object.entries(options).flatMap(([option, value]): UciOperation[] => {
        const key = `${identifier}.${option}`;
        return Array.isArray(value)
          ? [
              // Cleared first: a section of a kept type is not wiped, and
              // add_list would append to what it already holds on every run.
              // Silent when there is none (verified on 25.12.5).
              { op: "set", key, value: "" },
              ...value.map((item): UciOperation => ({ op: "add_list", key, value: render(item, option) })),
            ]
          : [{ op: "set", key, value: render(value, option) }];
      }),
    ];
  };
  return Object.entries(openWrtConfig).flatMap(([configKey, types]) =>
    Object.entries(types).flatMap(([type, sections]) => sections.flatMap((section) => sectionOperations(configKey, type, section)))
  );
};

/** The operations as shell commands: what tests, scripts and the equivalence check read. */
export const getUciCommands = (args: Parameters<typeof uciOperations>[0]): string[] =>
  uciOperations(args).map((o) => `uci ${uciLine(o)}`);
