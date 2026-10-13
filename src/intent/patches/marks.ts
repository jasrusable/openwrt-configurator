// Where a patch shows on a setting: only where it overrides the value that
// setting compiled to. Derived, never written: an amended option's origin is
// the setting it was set from (plan/types.ts' Origin), so a patch that
// changes it there marks that setting, by item (one SSID's fast roaming, not
// every SSID's). Patches that add files, restarts or options no setting sets
// mark nothing: the Fixes page and each device's page list them.
//
// The intent is never changed by a patch: the user's value stays as stored,
// and applies again as soon as the patch does not (switched off, its device
// past the release that fixed it, or the patch gone).
import type { DeviceSchema } from "../../deviceSchema";
import { appliesTo, deviceLookup } from "../../plan/device";
import type { When } from "../../plan/when";
import { compileFeatures } from "../compile";
import { matchPattern } from "../paths";
import type { Intent } from "../schema";
import { patches } from "./index";
import { amendedSettings, describeTarget, Patch, targetCondition } from "./patch";

export type PatchMark = {
  /** The setting it overrides, as a path ("wifi.networks.2.roaming.fast"). */
  path: string;
  patch: Patch;
  /** The condition of each section it overrides that setting in: which devices the setting reaches there. */
  sections: When[];
};

const computed = new WeakMap<Intent, { marks: PatchMark[]; devices: ReturnType<typeof compileFeatures>["devices"] }>();

const derive = (intent: Intent) => {
  const known = computed.get(intent);
  if (known) return known;
  const plan = compileFeatures(intent);
  const marks = amendedSettings(patches, intent, plan).flatMap(({ patch, overrides }) =>
    overrides.map(({ setting, sections }): PatchMark => ({ path: setting, patch, sections }))
  );
  const result = { marks, devices: plan.devices };
  computed.set(intent, result);
  return result;
};

/** Every override a needed patch makes on a setting; once per intent value (a draft's, as it is edited). */
export const patchMarks = (intent: Intent): PatchMark[] => derive(intent).marks;

/** The overrides on one setting, by its path. */
export const marksAt = (intent: Intent, path: readonly string[]) =>
  patchMarks(intent).filter((mark) => matchPattern(mark.path, path));

/** What a mark says, in words, for the setting's ⓘ: the patch's note (or title), where it holds, its first reference. */
export const markText = ({ patch }: PatchMark) => {
  const where = describeTarget(patch.target);
  const reference = patch.references[0]?.url;
  return `${patch.note ?? patch.title}${where ? ` (${where})` : ""}${reference ? `: ${reference}` : ""}.`;
};

/** Each device's facts, as stored: only its schema is read. */
export type Facts = Record<string, { schema: DeviceSchema } | undefined>;

export type Override = {
  patch: Patch;
  /** Devices the setting reaches. */
  reached: string[];
  /** Of those, where the patch overrides it. */
  overridden: string[];
  /** Devices whose facts are not read yet: whether it reaches them, or is overridden there, is not known. */
  unknown: string[];
  /** Overridden on every device the setting reaches, all known: the control is greyed out, its value kept. */
  everywhere: boolean;
};

/** How each patch overriding a setting holds across the devices, from their facts. */
export const overridesAt = (intent: Intent, facts: Facts, path: readonly string[]): Override[] => {
  const { devices } = derive(intent);
  return marksAt(intent, path).map((mark) => {
    const target = targetCondition(mark.patch.target);
    const each = devices.map((device) => {
      const schema = facts[device.hostname]?.schema;
      if (!schema) return { name: device.hostname, known: false, reached: false, overridden: false };
      const lookup = deviceLookup(device, schema);
      const reaching = mark.sections.filter((section) => appliesTo(section, lookup));
      return { name: device.hostname, known: true, reached: reaching.length > 0, overridden: reaching.length > 0 && appliesTo(target, lookup) };
    });
    const reached = each.filter((d) => d.reached).map((d) => d.name);
    const overridden = each.filter((d) => d.overridden).map((d) => d.name);
    const unknown = each.filter((d) => !d.known).map((d) => d.name);
    return { patch: mark.patch, reached, overridden, unknown, everywhere: !unknown.length && reached.length > 0 && overridden.length === reached.length };
  });
};

/** A chip's words: what overrides the setting, until when, where, and that the user's choice comes back. */
export const overrideText = ({ patch, overridden, everywhere }: Override) =>
  `Held off by fix “${patch.title}” until ${patch.dropWhen}${
    everywhere ? "" : overridden.length ? `, on ${overridden.join(", ")}` : ", where it applies"
  }. Your choice applies again then.`;
