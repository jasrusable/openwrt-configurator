import { OpenWRTConfig } from "./openWRTConfigSchema";

export const getLuciCommands = ({
  openWRTConfig,
}: {
  openWRTConfig: OpenWRTConfig;
}) => {
  const configKeys = Object.keys(openWRTConfig);
  const commands = configKeys.reduce<any[]>((acc, configKey) => {
    const sectionKeys = Object.keys((openWRTConfig as any)[configKey]);
    const sectionsCommands = sectionKeys.reduce<any[]>((acc, sectionKey) => {
      const sections = (openWRTConfig as any)[configKey][sectionKey] as any[];
      const sectionCommands = sections.reduce((acc, section, sectionIndex) => {
        const { name, properties } = section;
        const sectionName = name || `${sectionKey}${sectionIndex}`;
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

  return commands;
};
