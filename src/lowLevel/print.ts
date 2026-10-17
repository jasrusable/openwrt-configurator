// A plan as low-level JSON: what `compile` prints, in the language a
// hand-written config uses, and what parse.ts reads back into the same plan.
import { deviceToJson, fileToJson, serviceToJson } from "./names";
import { isPlaceholder, keepText, Options, Placeholder, Plan, Scalar, Section, Value } from "../plan/types";
import { writePlaceholder, writeText } from "./placeholders";
import { printWhen, When } from "../plan/when";
import { orderConfigs, orderOptions, orderTypes } from "../plan/uciOrder";

/** A value as written at `config.type.option`: placeholders and plain texts each as they read back. */
const printValue = (at: string, value: Value): unknown => {
  const item = (v: Scalar | Placeholder, whole: boolean) =>
    isPlaceholder(v) ? writePlaceholder(at, v, whole) : typeof v === "string" ? writeText(at, v, whole) : v;
  return Array.isArray(value) ? value.map((v) => item(v, false)) : item(value, true);
};

const printOptions = (config: string, type: string, options: Options) =>
  Object.fromEntries(Object.entries(orderOptions(config, type, options)).map(([key, value]) => [key, printValue(`${config}.${type}.${key}`, value)]));

const condition = (when: When | undefined) => (when ? { ".if": printWhen(when) } : {});

const printSection = (config: string, type: string, s: Section) => ({
  ...condition(s.when),
  ...(s.name !== undefined ? { ".name": s.name } : {}),
  ...printOptions(config, type, s.options),
  ...(s.overrides?.length
    ? {
        ".overrides": s.overrides.map((o) => ({
          ".if": printWhen(o.when),
          override: { ...(o.name !== undefined ? { ".name": o.name } : {}), ...printOptions(config, type, o.options) },
        })),
      }
    : {}),
});

export const printPlan = (plan: Plan) => ({
  ...(plan.version
    ? {
        version: plan.version.overrides?.length
          ? {
              ".value": plan.version.value,
              ".overrides": plan.version.overrides.map((o) => ({ ".if": printWhen(o.when), override: { ".value": o.value } })),
            }
          : plan.version.value,
      }
    : {}),
  devices: plan.devices.map(deviceToJson),
  package_profiles: plan.packages.map((p) => ({ ...condition(p.when), packages: [...(p.add ?? []), ...(p.remove ?? []).map((name) => `-${name}`)] })),
  services: plan.services.map(({ when, ...service }) => ({ ...condition(when), ...serviceToJson(service) })),
  files: plan.files.map(({ when, ...file }) => ({ ...condition(when), ...fileToJson(file) })),
  configs_to_not_reset: plan.keep.map((k) => ({ ...condition(k.when), configs: k.entries.map(keepText) })),
  ...(plan.newConfigs?.length ? { new_configs: plan.newConfigs } : {}),
  config: Object.fromEntries(
    Object.entries(orderConfigs(plan.config)).map(([config, types]) => [
      config,
      Object.fromEntries(
        Object.entries(orderTypes(config, types)).map(([type, sections]) => [type, sections.map((s) => printSection(config, type, s))])
      ),
    ])
  ),
});
