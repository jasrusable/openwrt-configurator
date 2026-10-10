import { OpenWrtConfig } from "./openWrtConfigSchema";
import { shellQuote } from "./shell";

// Values are quoted; names cannot be, so they must already be plain words.
// The five modelled packages are schema-checked, but a passthrough one
// (dropbear, sqm, ...) reaches here unchecked.
const packageName = /^[A-Za-z0-9_-]+$/;
const optionName = /^[A-Za-z0-9_]+$/;
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
  /** Replace a resolved secret before it is quoted into the script. */
  redact?: (value: string) => string;
}) => {
  // Booleans become 0/1 here. Only original strings are secrets, so a secret
  // whose text is "1" must not blank every flag.
  const render = (value: unknown): string | number => {
    if (typeof value === "boolean") return value ? "1" : "0";
    if (typeof value === "string" && redact) return redact(value);
    return value as string | number;
  };
  const configKeys = Object.keys(openWrtConfig);
  const configCommands = configKeys.reduce<string[]>((acc, configKey) => {
    const sectionKeys = Object.keys((openWrtConfig as any)[configKey]);
    const sectionsCommands = sectionKeys.reduce<any[]>((acc, sectionKey) => {
      const sections = (openWrtConfig as any)[configKey][sectionKey] as any[];
      const sectionCommands = sections.reduce((acc, section, sectionIndex) => {
        const sectionName = section[".name"];
        const resolvedSection = Object.fromEntries(
          Object.entries({ ...section }).filter(
            (e) => ![".name"].includes(e[0])
          )
        );
        checkName(configKey, packageName, "package");
        checkName(sectionKey, packageName, "section type");
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
                ? value.map(
                    (item) =>
                      `uci add_list ${identifier}.${key}=${shellQuote(
                        render(item)
                      )}`
                  )
                : [
                    `uci set ${identifier}.${key}=${shellQuote(render(value))}`,
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
