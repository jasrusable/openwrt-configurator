import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, oncConfigSchema, ONCDeviceConfig } from "./oncConfigSchema";
import { ExtensionSchema, Condition } from "./utils";

export const conditionMatches = ({
  condition,
  deviceConfig,
  deviceSchema,
}: {
  condition?: Condition;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  if (!condition) {
    return true;
  }

  const useSwConfig = deviceSchema.swConfig;

  const lhsMapping: any = Object.keys(deviceConfig.tags).reduce(
    (acc, tagKey) => {
      return {
        ...acc,
        [`tag.${tagKey}`]: deviceConfig.tags[tagKey],
      };
    },
    { sw_config: useSwConfig }
  );

  const equals = condition.split(" == ");
  if (equals.length === 2) {
    const [lhs, rhs] = equals;
    const value = lhsMapping[lhs];
    const parsedRhs = JSON.parse(rhs.replace(/\'/g, `"`));
    if (Array.isArray(value)) {
      return value.includes(parsedRhs);
    }
    return value === parsedRhs;
  }

  const notEquals = condition.split(" != ");
  if (notEquals.length === 2) {
    const [lhs, rhs] = notEquals;
    const value = lhsMapping[lhs];
    const parsedRhs = JSON.parse(rhs.replace(/\'/g, `"`));
    if (Array.isArray(value)) {
      return !value.includes(parsedRhs);
    }
    return value !== parsedRhs;
  }

  throw new Error(`Unable to parse condition: ${condition}`);
};

export const resolveOncConfig = ({
  deviceConfig,
  deviceSchema,
  oncConfig,
}: {
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
  oncConfig: ONCConfig;
}) => {
  const applyObject = <S extends Record<string, any>>(object: S) => {
    const sectionConfig = object as ExtensionSchema | undefined;
    const condition = sectionConfig?.[".condition"];
    const matches = conditionMatches({
      condition: condition,
      deviceConfig,
      deviceSchema,
    });
    const overrides = (sectionConfig?.[".conditional_overrides"] || [])
      .filter((override) => {
        return conditionMatches({
          condition: override[".condition"],
          deviceConfig,
          deviceSchema,
        });
      })
      .reduce((acc, override) => {
        return { ...acc, ...override.overrides };
      }, {});

    // Strip off conditional things.
    const data = Object.fromEntries(
      Object.entries({ ...object, ...overrides }).filter(
        (e) => ![".condition", ".conditional_overrides"].includes(e[0])
      )
    );

    return matches ? data : {};
  };

  const resolvedOncConfig = Object.keys(oncConfig.config).reduce(
    (config, configKey) => {
      const a = applyObject((oncConfig.config as any)[configKey]);
      const resolvedConfig = Object.keys(a).reduce((section, sectionKey) => {
        const sections: any[] = (a as any)[sectionKey] || [];
        const resolvedSections = sections
          .map((section) => {
            const resolvedSection = applyObject(section);
            return resolvedSection;
          })
          .filter((section) => Object.keys(section).length > 0);
        return { ...section, [sectionKey]: resolvedSections };
      }, {});
      return { ...config, [configKey]: resolvedConfig };
    },
    {}
  );

  const parsedConfig = oncConfigSchema.shape.config.parse(resolvedOncConfig);

  return parsedConfig;
};
