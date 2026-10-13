// Where each fix applies, device by device: the intent decides its role and
// whether the settings need it at all; each device's facts (model, target,
// release, radios) decide the rest. Pure, so System › Patches (with the draft),
// the API and Status say the same.
import type { DeviceSchema } from "../../deviceSchema";
import { deviceLookup } from "../../plan/device";
import { evaluateChecked, when } from "../../plan/when";
import { compareReleases } from "../../release";
import type { Intent } from "../schema";
import { patches } from "./index";
import { describeTarget, effectsOf, Patch } from "./patch";

/**
 * What a fix does on a device: active; turned off by you; not needed by
 * the settings; not for this device (role, model, target, radio, an older
 * release); past it (the device runs a release with the fix); or not known
 * yet (its facts not read).
 */
export type FixState = "active" | "off" | "unused" | "elsewhere" | "fixed" | "unknown";

export type DeviceFix = { device: string; state: FixState; why?: string };

export type FixView = Pick<Patch, "id" | "title" | "why" | "kind" | "note" | "references" | "added" | "verified" | "dropWhen" | "affects"> & {
  required: boolean;
  /** Where it applies, as far as devices decide ("on zyxel,nwa50ax-pro, before OpenWrt 25.12.6"). */
  where: string;
  /** What it does, in words (effectsOf). */
  effects: string[];
  devices: DeviceFix[];
};

/** Each device's facts, as stored (deviceFacts.ts): only its schema is read. */
export type Facts = Record<string, { schema: DeviceSchema } | undefined>;

const onDevice = (patch: Patch, intent: Intent, device: Intent["hardware"][number], facts: Facts): Omit<DeviceFix, "device"> => {
  if ((intent.system.patches?.off ?? []).includes(patch.id)) return { state: "off", why: "turned off" };
  if (patch.applies && !patch.applies(intent)) return { state: "unused", why: "not needed by your settings" };
  const { models, targets, roles, releases, requires } = patch.target;
  if (roles && !roles.includes(device.role)) return { state: "elsewhere", why: `only on ${roles.map((r) => `${r}s`).join(" and ")}` };
  const schema = facts[device.name]?.schema;
  if (!schema) return { state: "unknown", why: "not read yet" };
  const lookup = deviceLookup({ hostname: device.name, tags: { role: device.role } }, schema);
  const holds = (condition: Parameters<typeof evaluateChecked>[0]) => evaluateChecked(condition, lookup);
  if (models && !holds(when.oneOf("device.model_id", models))) return { state: "elsewhere", why: `only on ${models.join(" or ")}` };
  if (targets && !holds(when.oneOf("device.target", targets))) return { state: "elsewhere", why: `only on ${targets.join(" or ")}` };
  if (requires && !holds(requires.when)) return { state: "elsewhere", why: `only where it ${requires.note}` };
  if (releases?.from && (compareReleases(schema.version, releases.from) ?? 0) < 0)
    return { state: "elsewhere", why: `from OpenWrt ${releases.from}; it runs ${schema.version}` };
  if (releases?.before && (compareReleases(schema.version, releases.before) ?? -1) >= 0)
    return { state: "fixed", why: `fixed in OpenWrt ${releases.before}; it runs ${schema.version}` };
  return { state: "active" };
};

/** Every fix, with where it applies on each device of the intent. */
export const patchStatus = (intent: Intent, facts: Facts): FixView[] =>
  patches.map((patch) => ({
    id: patch.id,
    title: patch.title,
    why: patch.why,
    kind: patch.kind,
    ...(patch.note ? { note: patch.note } : {}),
    references: patch.references,
    added: patch.added,
    verified: patch.verified,
    dropWhen: patch.dropWhen,
    ...(patch.affects?.length ? { affects: patch.affects } : {}),
    required: !!patch.required,
    where: describeTarget(patch.target),
    effects: effectsOf(patch, intent),
    devices: intent.hardware.map((device) => ({ device: device.name, ...onDevice(patch, intent, device, facts) })),
  }));

/**
 * Fixes past their use: needed by the settings, yet every device they would
 * apply to already runs the release that fixed them. Time to drop the patch.
 */
export const droppableFixes = (intent: Intent, facts: Facts) =>
  patchStatus(intent, facts).filter(
    (fix) => fix.devices.some((d) => d.state === "fixed") && !fix.devices.some((d) => d.state === "active" || d.state === "unknown")
  );
