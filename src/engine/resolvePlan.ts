// A plan's declarations for one device: those whose conditions hold, each
// section with its matching overrides merged in. Placeholders are left for
// getOpenWrtConfig, which fits them to the device's hardware.
import { DeviceSchema } from "../deviceSchema";
import { appliesTo, deviceLookup } from "../plan/device";
import { Options, Plan, PlanDevice, Sections } from "../plan/types";
import { Lookup, When } from "../plan/when";

/** A section as it applies to one device: its name, if it has one, and its options. */
export type ResolvedSection = { name?: string; options: Options };
export type ResolvedSections = Record<string, Record<string, ResolvedSection[]>>;

export const resolveSections = (config: Sections, lookup: Lookup): ResolvedSections =>
  Object.fromEntries(
    Object.entries(config).map(([configKey, types]) => [
      configKey,
      Object.fromEntries(
        Object.entries(types).map(([type, sections]) => [
          type,
          sections
            .filter((s) => appliesTo(s.when, lookup))
            .map((s) => {
              // Each matching override merged over the last, its name too where it gives one.
              const matching = (s.overrides ?? []).filter((o) => appliesTo(o.when, lookup));
              const name = matching.reduce<string | undefined>((current, o) => o.name ?? current, s.name);
              return {
                ...(name !== undefined ? { name } : {}),
                options: matching.reduce<Options>((options, o) => ({ ...options, ...o.options }), s.options),
              };
            }),
        ])
      ),
    ])
  );

/** What the plan declares for a device beside its config: packages, services, files, what the wipe keeps. */
export const resolveDeclarations = (plan: Plan, device: PlanDevice, schema: DeviceSchema) => {
  const lookup = deviceLookup(device, schema);
  const applying = <T extends { when?: When }>(items: T[]) => items.filter((item) => appliesTo(item.when, lookup));
  return {
    lookup,
    packages: applying(plan.packages),
    services: applying(plan.services),
    files: applying(plan.files),
    keep: applying(plan.keep),
  };
};
