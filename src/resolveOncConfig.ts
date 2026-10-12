import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, oncConfigSchema, ONCDeviceConfig } from "./oncConfigSchema";
import { evaluateCondition } from "./condition";
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
  if (!condition) return true;
  const builtIn: Record<string, string | boolean | undefined> = {
    "device.sw_config": deviceSchema.sw_config,
    "device.hostname": deviceConfig.hostname,
    "device.ipaddr": deviceConfig.ipaddr,
    "device.model_id": deviceConfig.model_id ?? deviceSchema.name,
    "device.version": deviceSchema.version,
    // Whether it has a radio in each band: for config only a radio there can
    // carry (a mesh on a router that may or may not have Wi-Fi).
    ...Object.fromEntries(
      ["2g", "5g", "6g"].map((band) => [
        `device.wifi_${band}`,
        (deviceSchema.radios ?? []).some((r) => r.band === band),
      ])
    ),
  };
  return evaluateCondition(condition, (name) => {
    if (name.startsWith("device.tag.")) {
      // A tag this device does not set is absent, not an error: conditions
      // are shared by every device, and not every device sets every tag.
      return { value: deviceConfig.tags[name.slice("device.tag.".length)] };
    }
    if (name in builtIn) return { value: builtIn[name] };
    throw new Error(
      `unknown name ${name}; use device.tag.<key> or one of ${Object.keys(
        builtIn
      ).join(", ")}`
    );
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
    const condition = sectionConfig?.[".if"];
    const matches = conditionMatches({
      condition: condition,
      deviceConfig,
      deviceSchema,
    });
    const overrides = (sectionConfig?.[".overrides"] || [])
      .filter((override) => {
        return conditionMatches({
          condition: override[".if"],
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
        (e) => ![".if", ".overrides"].includes(e[0])
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
