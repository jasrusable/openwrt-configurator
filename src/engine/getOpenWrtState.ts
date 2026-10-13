// Everything an apply does on one device, from the plan: its config
// (getOpenWrtConfig), the packages to add and remove, the services to keep
// on or off, the files to write, and what the wipe leaves alone.
import { DeviceSchema } from "../deviceSchema";
import { getOpenWrtConfig } from "./getOpenWrtConfig";
import { OpenWrtState } from "./openWrtState";
import { Plan, PlanDevice } from "../plan/types";
import { resolveDeclarations } from "./resolvePlan";

type ServiceState = OpenWrtState["services"][number];

export const getOpenWrtState = ({
  plan,
  deviceConfig,
  deviceSchema,
}: {
  plan: Plan;
  deviceConfig: PlanDevice;
  deviceSchema: DeviceSchema;
}): OpenWrtState => {
  const declared = resolveDeclarations(plan, deviceConfig, deviceSchema);
  const unique = (lists: (string[] | undefined)[]) => [...new Set(lists.flatMap((list) => list ?? []))];

  // One entry per service: running if any declaration says so, and off
  // only if every declaration says so.
  const services = declared.services.reduce<ServiceState[]>((acc, { name, running, enabled, restartAfterRollback }) => {
    const on = enabled !== false;
    const known = acc.find((s) => s.name === name);
    const restart = !!restartAfterRollback || !!known?.restartAfterRollback;
    const merged = {
      ...(known
        ? { name, running: known.running || !!running, ...(known.enabled === false && !on ? { enabled: false } : {}) }
        : { name, running: !!running, ...(on ? {} : { enabled: false }) }),
      ...(restart ? { restartAfterRollback: true } : {}),
    };
    return known ? acc.map((s) => (s.name === name ? merged : s)) : [...acc, merged];
  }, []);

  // One file per path, the last declaration's.
  const files = [
    ...new Map(
      declared.files.map(({ path, content, mode, runAfter, runAfterReload }) => [
        path,
        { path, content, mode, runAfter, runAfterReload },
      ])
    ).values(),
  ];

  return {
    config: getOpenWrtConfig({ plan, deviceConfig, deviceSchema }),
    packages: { add: unique(declared.packages.map((p) => p.add)), remove: unique(declared.packages.map((p) => p.remove)) },
    // What the wipe leaves alone. The rest is worked out against the device's
    // actual config, read after the package step (see stageRecords).
    keep: declared.keep.flatMap((k) => k.entries),
    services,
    files,
  };
};
