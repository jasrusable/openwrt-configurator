import { Redact } from "./secretOptions";
import { OpenWrtConfig } from "./openWrtConfigSchema";
import { shellQuote } from "./shell";

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
}) => {
  // Booleans become 0/1 here. Only original strings are secrets, so a secret
  // whose text is "1" must not blank every flag.
  const render = (value: unknown, option: string): string | number => {
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "string" && redact) return redact(value, { option });
    return value as string | number;
  };
  const configKeys = Object.keys(openWrtConfig);
  const configCommands = configKeys.reduce<string[]>((acc, configKey) => {
    const sectionKeys = Object.keys((openWrtConfig as any)[configKey]);
    const sectionsCommands = sectionKeys.reduce<any[]>((acc, sectionKey) => {
      const sections = (openWrtConfig as any)[configKey][sectionKey] as any[];
      const sectionCommands = sections.reduce((acc, section, sectionIndex) => {
        const sectionName = section[".name"];
        // An unset value (a radio mode no width fits, say) is no option at
        // all, OpenWrt's default, as declaredConfigs reads it: never the text
        // "undefined", which verify would then refuse.
        const resolvedSection = Object.fromEntries(
          Object.entries({ ...section }).filter(
            ([key, value]) => key !== ".name" && value !== undefined && value !== null
          )
        );
        checkName(configKey, packageName, "package");
        checkName(sectionKey, packageName, "section type");
        if (sectionName !== undefined) checkName(sectionName, sectionNamePattern, "section");
        Object.keys(resolvedSection).forEach((key) =>
          checkName(key, optionName, "option")
        );
        const identifier = `${configKey}.${sectionName}`;
        const commands = [
          `uci set ${identifier}=${sectionKey}`,
          ...Object.keys(resolvedSection).reduce<string[]>((acc, key) => {
            const value = resolvedSection[key];
            return [
              ...acc,
              ...(Array.isArray(value)
                ? [
                    // Cleared first: a section of a kept type is not wiped,
                    // and add_list would append to what it already holds on
                    // every run. Silent when there is none (verified on 25.12.5).
                    `uci set ${identifier}.${key}=''`,
                    ...value.map(
                      (item) =>
                        `uci add_list ${identifier}.${key}=${shellQuote(
                          render(item, key)
                        )}`
                    ),
                  ]
                : [
                    `uci set ${identifier}.${key}=${shellQuote(render(value, key))}`,
                  ]),
            ];
          }, []),
        ];
        return [...acc, ...commands];
      }, []);
      return [...acc, ...sectionCommands];
    }, []);
    return [...acc, ...sectionsCommands];
  }, []);

  return configCommands;
};
