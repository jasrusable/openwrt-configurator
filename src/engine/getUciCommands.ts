import { Redact } from "../secretOptions";
import { OpenWrtConfig, OpenWrtSection, UciScalar } from "./openWrtState";
import { shellQuote } from "../shell";

// Values are quoted; names cannot be, so they must already be plain words.
// The five modelled packages are schema-checked, but a passthrough one
// (dropbear, sqm, ...) reaches here unchecked.
const packageName = /^[A-Za-z0-9_-]+$/;
const optionName = /^[A-Za-z0-9_]+$/;
// uci refuses a section name with a hyphen ("Invalid argument", verified on
// 25.12.5) while `uci batch` still exits 0: caught here, not after packages.
const sectionNamePattern = /^[A-Za-z0-9_]+$/;
const checkName = (name: string, pattern: RegExp, what: string) => {
  if (!pattern.test(name)) {
    throw new Error(
      `Invalid UCI ${what} name ${JSON.stringify(
        name
      )}: use letters, digits and _` +
        (pattern === packageName ? " or -" : "") +
        "."
    );
  }
};

export const getUciCommands = ({
  openWrtConfig,
  redact,
}: {
  openWrtConfig: OpenWrtConfig;
  /** Replace a secret before it is quoted into the script. */
  redact?: Redact;
}): string[] => {
  // Booleans become 0/1 here. Only original strings are secrets, so a secret
  // whose text is "1" must not blank every flag.
  const render = (value: UciScalar, option: string) =>
    typeof value === "boolean" ? (value ? "1" : "0") : typeof value === "string" && redact ? redact(value, { option }) : value;
  const sectionCommands = (configKey: string, type: string, section: OpenWrtSection) => {
    const { ".name": name, ...options } = section;
    checkName(configKey, packageName, "package");
    checkName(type, packageName, "section type");
    checkName(name, sectionNamePattern, "section");
    Object.keys(options).forEach((key) => checkName(key, optionName, "option"));
    const identifier = `${configKey}.${name}`;
    return [
      `uci set ${identifier}=${type}`,
      ...Object.entries(options).flatMap(([key, value]) =>
        Array.isArray(value)
          ? [
              // Cleared first: a section of a kept type is not wiped, and
              // add_list would append to what it already holds on every run.
              // Silent when there is none (verified on 25.12.5).
              `uci set ${identifier}.${key}=''`,
              ...value.map((item) => `uci add_list ${identifier}.${key}=${shellQuote(render(item, key))}`),
            ]
          : [`uci set ${identifier}.${key}=${shellQuote(render(value, key))}`]
      ),
    ];
  };
  return Object.entries(openWrtConfig).flatMap(([configKey, types]) =>
    Object.entries(types).flatMap(([type, sections]) => sections.flatMap((section) => sectionCommands(configKey, type, section)))
  );
};
