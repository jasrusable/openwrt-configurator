import { omit } from "lodash";
import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, oncConfigSchema, ONCDeviceConfig } from "./oncConfigSchema";
import { ExtensionSchema, Target } from "./utils";

export const resolveOncConfig = ({
  deviceConfig,
  deviceSchema,
  oncConfig,
}: {
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
  oncConfig: ONCConfig;
}) => {
  const useSwConfig = deviceSchema.swConfig;

  const targetMatches = (target?: Target) => {
    if (!target) {
      return true;
    }

    const lhsMapping: any = Object.keys(deviceConfig.tags).reduce(
      (acc, tagKey) => {
        return {
          ...acc,
          [`tag.${tagKey}`]: deviceConfig.tags[tagKey],
        };
      },
      { sw_config: useSwConfig }
    );

    const equals = target.split(" == ");
    if (equals.length === 2) {
      const [lhs, rhs] = equals;
      const value = lhsMapping[lhs];
      const parsedRhs = JSON.parse(rhs.replace(/\'/g, `"`));
      if (Array.isArray(value)) {
        return value.includes(parsedRhs);
      }
      return value === parsedRhs;
    }

    const notEquals = target.split(" != ");
    if (notEquals.length === 2) {
      const [lhs, rhs] = notEquals;
      const value = lhsMapping[lhs];
      const parsedRhs = JSON.parse(rhs.replace(/\'/g, `"`));
      if (Array.isArray(value)) {
        return !value.includes(parsedRhs);
      }
      return value !== parsedRhs;
    }

    throw new Error(`Unable to parse target: ${target}`);
  };

  const applyObject = <S extends Record<string, any>>(object: S) => {
    const sectionConfig = object["."] as ExtensionSchema | undefined;
    const target = sectionConfig?.target;
    const matches = targetMatches(target);
    const overrides = (sectionConfig?.target_overrides || [])
      .filter((override) => {
        return targetMatches(override.target);
      })
      .reduce((acc, override) => {
        return { ...acc, ...override.overrides };
      }, {});
    return matches ? omit({ ...object, ...overrides }, ".") : {};
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
