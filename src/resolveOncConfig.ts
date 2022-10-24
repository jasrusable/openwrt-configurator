import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, oncConfigSchema, ONCDeviceConfig } from "./oncConfigSchema";
import { ExtensionSchema, Condition } from "./utils";
// @ts-ignore
import booleanParser from "boolean-parser";

export const conditionMatches = ({
  condition,
  deviceConfig,
  deviceSchema,
}: {
  condition?: Condition;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  if (!condition || condition === "*") {
    return true;
  }

  const useSwConfig = deviceSchema.sw_config;

  const lhsMapping: any = Object.keys(deviceConfig.tags).reduce(
    (acc, tagKey) => {
      return {
        ...acc,
        [`device.tag.${tagKey}`]: deviceConfig.tags[tagKey],
      };
    },
    {
      [`device.sw_config`]: useSwConfig,
      [`device.hostname`]: deviceConfig.hostname,
      ["device.ipaddr"]: deviceConfig.ipaddr,
      ["device.model_id"]: deviceConfig.model_id,
      ["device.version"]: deviceSchema.version,
    }
  );

  const query: string[][] = booleanParser.parseBooleanQuery(condition);

  return query.some((q) => {
    return q.every((s) => {
      const equals = s.replace(/\s/g, "").split("==");
      if (equals.length === 2) {
        const [lhs, rhs] = equals;
        const value = lhsMapping[lhs];
        if (value === undefined) {
          throw new Error(
            `Invalid conditional parameter defined: ${lhs}. Must be one of ${Object.keys(
              lhsMapping
            ).join(" ")}.`
          );
        }
        const parsedRhs = JSON.parse(rhs.replace(/\'/g, `"`));
        if (Array.isArray(value)) {
          return value.includes(parsedRhs);
        }
        return value === parsedRhs;
      }

      const notEquals = s.replace(/\s/g, "").split("!=");
      if (notEquals.length === 2) {
        const [lhs, rhs] = notEquals;
        const value = lhsMapping[lhs];
        if (value === undefined) {
          throw new Error(
            `Invalid conditional parameter defined: ${lhs}. Must be one of ${Object.keys(
              lhsMapping
            ).join(" ")}.`
          );
        }
        const parsedRhs = JSON.parse(rhs.replace(/\'/g, `"`));
        if (Array.isArray(value)) {
          return !value.includes(parsedRhs);
        }
        return value !== parsedRhs;
      }

      throw new Error(`Unable to parse condition: ${condition}`);
    });
  });
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
    const overrides = (sectionConfig?.[".overrides"] || [])
      .filter((override) => {
        return conditionMatches({
          condition: override[".condition"],
          deviceConfig,
          deviceSchema,
        });
      })
      .reduce((acc, override) => {
        return { ...acc, ...override.override };
      }, {});

    // Strip off conditional things.
    const data = Object.fromEntries(
      Object.entries({ ...object, ...overrides }).filter(
        (e) => ![".condition", ".overrides"].includes(e[0])
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
