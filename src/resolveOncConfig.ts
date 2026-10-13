import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, oncConfigSchema, ONCDeviceConfig } from "./oncConfigSchema";
import { evaluateCondition } from "./condition";
import { ExtensionSchema, Condition, parseSchema } from "./utils";

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
    // And one there that can mesh (802.11s; unknown counts as yes, as facts
    // read before it was asked do not say).
    ...Object.fromEntries(
      ["2g", "5g", "6g"].map((band) => [
        `device.mesh_${band}`,
        (deviceSchema.radios ?? []).some((r) => r.band === band && r.mesh !== false),
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
  const matches = (condition?: Condition) => conditionMatches({ condition, deviceConfig, deviceSchema });
  // An object for this device: undefined where its .if does not match, else
  // with each matching override applied and the conditions stripped (a
  // section left with no options, all defaults, is still a section).
  const applyObject = (object: Record<string, any> & ExtensionSchema): Record<string, any> | undefined => {
    if (!matches(object[".if"])) return undefined;
    const { ".if": _if, ".overrides": overrides, ...data } = object;
    return (overrides || [])
      .filter((override) => matches(override[".if"]))
      .reduce((acc, override) => ({ ...acc, ...override.override }), data);
  };

  const resolved = Object.fromEntries(
    Object.entries(oncConfig.config).map(([configKey, config]) => [
      configKey,
      Object.fromEntries(
        Object.entries(applyObject(config as Record<string, any>) ?? {}).map(([sectionKey, sections]) => [
          sectionKey,
          ((sections as Record<string, any>[]) || []).flatMap((section) => applyObject(section) ?? []),
        ])
      ),
    ])
  );

  return parseSchema(oncConfigSchema.shape.config, resolved);
};
