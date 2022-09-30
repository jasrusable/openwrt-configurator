import { omit } from "lodash";
import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, oncConfigSchema, ONCDeviceConfig } from "./oncConfigSchema";
import { ExtensionSchema, Targets } from "./utils";

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

  const targetMatches = (targets?: Targets) => {
    if (!targets) {
      return true;
    }

    if (typeof targets === "string") {
      return targets === "*";
    }

    const tagMatches =
      Array.isArray(targets) &&
      targets.find((target) =>
        deviceConfig.tags.find((tag) =>
          tag.name === target.tag &&
          typeof target.value === "string" &&
          target.value === "*"
            ? true
            : Array.isArray(target.value)
            ? !!target.value.find((val) => tag.value.includes(val))
            : false
        )
      );
    if (tagMatches) {
      return true;
    }

    const optMatches =
      Array.isArray(targets) &&
      targets.find(
        (target) => target.opt === "sw_config" && target.value === useSwConfig
      );

    if (optMatches) {
      return true;
    }

    return false;
  };

  const applyObject = <S extends Record<string, any>>(object: S) => {
    const sectionConfig = object["."] as ExtensionSchema | undefined;
    const targets = sectionConfig?.targets;
    const matches = targetMatches(targets);
    const overrides = (sectionConfig?.target_overrides || [])
      .filter((override) => {
        return targetMatches(override.targets);
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
