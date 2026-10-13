// A plan's config fitted to one device: conditions decided (resolvePlan.ts),
// then every placeholder resolved against its hardware (its ports:
// engine/ports.ts; its radios: engine/radios.ts), sections named, and the
// result checked for clashes uci batch would merge silently and for what a
// section cannot do without.
import { DeviceSchema } from "../deviceSchema";
import { fitPorts } from "./ports";
import { fitRadios } from "./radios";
import { sanitizeName, writeSection } from "./values";
import { OpenWrtConfig } from "./openWrtState";
import { deviceLookup } from "../plan/device";
import { deviceConfigIssues } from "../plan/rules";
import { Plan, PlanDevice } from "../plan/types";
import { resolveSections } from "./resolvePlan";
import { orderConfigs, orderTypes } from "./uciOrder";

export const getOpenWrtConfig = ({
  plan,
  deviceConfig,
  deviceSchema,
}: {
  plan: Plan;
  deviceConfig: PlanDevice;
  deviceSchema: DeviceSchema;
}): OpenWrtConfig => {
  const { hostname } = deviceConfig;
  const resolved = resolveSections(plan.config, deviceLookup(deviceConfig, deviceSchema));
  const { config: withPorts, portOptions } = fitPorts({ hostname, deviceSchema, resolved });
  const written = writeSection(hostname);

  // Every config but the radios', each section named (by its type and place
  // when it has no name) with what the engine works out for it: the
  // hostname, and port lists.
  const resolvedOpenWrtConfig: OpenWrtConfig = Object.fromEntries(
    Object.entries(withPorts)
      .filter(([configKey]) => configKey !== "wireless")
      .map(([configKey, types]) => [
        configKey,
        Object.fromEntries(
          Object.entries(types).map(([type, sections]) => [
            type,
            sections.map((s, index) =>
              written(configKey, type, s.name || sanitizeName(`${type}${index}`), {
                ...s.options,
                ...(configKey === "system" && type === "system" ? { hostname } : portOptions(configKey, type, s)),
              })
            ),
          ])
        ),
      ])
  );

  const wireless = fitRadios({ hostname, deviceSchema, wireless: resolved.wireless });
  const final: OpenWrtConfig = orderConfigs({ ...resolvedOpenWrtConfig, ...(wireless ? { wireless } : {}) });

  // Two sections of one name would be merged by uci batch, silently.
  Object.entries(final).forEach(([configKey, types]) => {
    const names = Object.values(types).flatMap((sections) => sections.map((section) => section[".name"]));
    const repeated = names.filter((name, i) => names.indexOf(name) !== i);
    if (repeated.length > 0) {
      throw new Error(`${configKey}: more than one section named ${[...new Set(repeated)].join(", ")}`);
    }
  });

  // A type with no section on this device (each one's condition false) is not there at all.
  const config = Object.fromEntries(
    Object.entries(final).map(([configKey, types]) => [
      configKey,
      orderTypes(configKey, Object.fromEntries(Object.entries(types).filter(([, sections]) => sections.length > 0))),
    ])
  );
  // What a section cannot do without, once overrides are merged and placeholders fitted.
  const issues = deviceConfigIssues(config);
  if (issues.length > 0) throw new Error(`${hostname}: ${issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return config;
};
