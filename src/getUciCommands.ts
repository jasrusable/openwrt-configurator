import { OpenWrtConfig } from "./openWrtConfigSchema";

export const getUciCommands = ({
  openWrtConfig,
}: {
  openWrtConfig: OpenWrtConfig;
}) => {
  const configKeys = Object.keys(openWrtConfig);
  const configCommands = configKeys.reduce<string[]>((acc, configKey) => {
    const sectionKeys = Object.keys((openWrtConfig as any)[configKey]);
    const sectionsCommands = sectionKeys.reduce<any[]>((acc, sectionKey) => {
      const sections = (openWrtConfig as any)[configKey][sectionKey] as any[];
      const sectionCommands = sections.reduce((acc, section, sectionIndex) => {
        const { name, properties } = section;
        const sectionName = name;
        const identifier = `${configKey}.${sectionName}`;
        const commands = [
          `uci set ${identifier}=${sectionKey}`,
          ...Object.keys(properties).reduce<string[]>((acc, key) => {
            const value = properties[key];
            const coercedValue =
              typeof value === "boolean" ? (value === true ? "1" : "0") : value;
            return [
              ...acc,
              ...(Array.isArray(value)
                ? value.map((item) => {
                    const coercedValue =
                      typeof item === "boolean"
                        ? item === true
                          ? "1"
                          : "0"
                        : item;
                    return `uci add_list ${identifier}.${key}='${coercedValue}'`;
                  })
                : [`uci set ${identifier}.${key}='${coercedValue}'`]),
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
