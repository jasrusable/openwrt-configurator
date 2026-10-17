// Where each fix applies, device by device: the intent decides its role and
// whether the settings need it at all; each device's facts (model, target,
// release, radios) decide the rest. Pure, so System › Patches (with the draft),
// the API and Status say the same.
import { deviceLookup } from "../../plan/device";
import { evaluateChecked, Lookup } from "../../plan/when";
import { compileFeatures } from "../compile";
import type { Intent } from "../schema";
import { patches } from "./index";
import { amendedSettings, describeTarget, effectsOf, Facts, Patch, targetParts } from "./patch";

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

/**
 * A fix on one device, by the first part of its target (targetParts, the
 * engine's own condition) the device misses: its role from the intent, the
 * rest from its facts.
 */
const onDevice = (patch: Patch, intent: Intent, device: Intent["hardware"][number], facts: Facts): Omit<DeviceFix, "device"> => {
  if ((intent.system.patches?.off ?? []).includes(patch.id)) return { state: "off", why: "turned off" };
  if (patch.applies && !patch.applies(intent)) return { state: "unused", why: "not needed by your settings" };
  const parts = targetParts(patch.target);
  const role = parts.find((part) => part.role);
  const byRole: Lookup = (name) => ({ value: name === "device.tag.role" ? device.role : undefined });
  if (role && !evaluateChecked(role.when, byRole)) return { state: "elsewhere", why: `only ${role.words}` };
  const schema = facts[device.name]?.schema;
  if (!schema) return { state: "unknown", why: "not read yet" };
  const lookup = deviceLookup({ hostname: device.name, tags: { role: device.role } }, schema);
  const missed = parts.find((part) => !evaluateChecked(part.when, lookup));
  if (!missed) return { state: "active" };
  const runs = missed.release ? `; it runs ${schema.version}` : "";
  return missed.fixed
    ? { state: "fixed", why: `fixed in OpenWrt ${missed.release}${runs}` }
    : { state: "elsewhere", why: `only ${missed.words}${runs}` };
};

/**
 * Patches the pages list: those that override a setting's compiled value.
 * One turned off still counts, so it can be turned back on. The rest apply
 * and stay off the pages.
 */
export const shownPatches = (intent: Intent): string[] => {
  const on: Intent = { ...intent, system: { ...intent.system, patches: { ...intent.system.patches, off: [] } } };
  return amendedSettings(patches, on, compileFeatures(on))
    .filter((found) => found.overrides.length > 0)
    .map((found) => found.patch.id);
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
