// A patch: a fix or tuning layered over what OpenWrt ships, kept apart from
// the features so it can be added for a model, a role or a release as
// problems are found, and dropped when OpenWrt fixes them upstream. It says
// why it exists, what it targets and, for a fix waiting on OpenWrt, the
// upstream issue; everything it emits applies only where it targets.
import { Feature, merge } from "../fragment";
import type { Fragment } from "../../plan/types";
import { KeepEntry, PlanFile, Sections, Service } from "../../plan/types";
import { when, When } from "../../plan/when";
import { Intent } from "../schema";

type Role = Intent["hardware"][number]["role"];

/** Where a patch applies, each part narrowing it; empty is every device. */
export type Target = {
  /** Board ids, as /etc/board.json has them (device.model_id). */
  models?: string[];
  roles?: Role[];
  /** OpenWrt releases: from one (inclusive), before another (exclusive). */
  releases?: { from?: string; before?: string };
};

export type Patch = {
  /** Short and stable, like "r6s-packet-steering". */
  id: string;
  /** The problem it fixes, and how it was seen (a measurement, a report). */
  why: string;
  /** The upstream issue or fix to watch: when it lands, the patch goes (and gets `releases.before`). */
  upstream?: string;
  target: Target;
  /** Whether the intent needs it at all (a service that is on); unset, always. */
  applies?: (intent: Intent) => boolean;
  /** What it changes, without conditions: the target is added to each. */
  apply: (intent: Intent) => {
    files?: Omit<PlanFile, "when">[];
    config?: Sections;
    packages?: { add?: string[]; remove?: string[] };
    /** What the wipe leaves alone on the target. */
    keeps?: KeepEntry[];
    services?: Omit<Service, "when">[];
  };
};

/** The target as a condition: each part narrowing it, every device when it has none. */
export const targetCondition = ({ models, roles, releases }: Target): When => {
  const parts = [
    ...(models ? [when.oneOf("device.model_id", models)] : []),
    ...(roles ? [when.oneOf("device.tag.role", roles)] : []),
    ...(releases?.from ? [when.order("device.version", ">=", releases.from)] : []),
    ...(releases?.before ? [when.order("device.version", "<", releases.before)] : []),
  ];
  return parts.length ? when.all(...parts) : when.always;
};

/** What the device facts (model, release) still decide, in words; roles are known from the intent. */
export const describeTarget = ({ models, releases }: Target) =>
  [
    models && `on ${models.join(" or ")}`,
    releases?.from && `from OpenWrt ${releases.from}`,
    releases?.before && `before OpenWrt ${releases.before}`,
  ]
    .filter(Boolean)
    .join(", ");

const needed = (intent: Intent) => (patch: Patch) => patch.applies?.(intent) ?? true;

/** A patch's changes, each made conditional on its target. */
const fragmentOf = (patch: Patch, intent: Intent): Fragment => {
  const target = targetCondition(patch.target);
  const { files = [], config = {}, packages, keeps = [], services = [] } = patch.apply(intent);
  // The target narrows what each declares for itself, never replaces it.
  const onTarget = <T extends object>(item: T & { when?: When }): T & { when: When } => ({
    ...item,
    when: when.all(target, item.when ?? when.always),
  });
  return {
    files: files.map(onTarget),
    packages: packages?.add?.length || packages?.remove?.length ? [{ when: target, ...packages }] : [],
    keep: keeps.length ? [{ when: target, entries: keeps }] : [],
    services: services.map(onTarget),
    config: Object.fromEntries(
      Object.entries(config).map(([key, types]) => [
        key,
        Object.fromEntries(Object.entries(types).map(([type, sections]) => [type, sections.map(onTarget)])),
      ])
    ),
  };
};

/** Every patch the intent needs, as one fragment (merged in the patches' order). */
export const applyPatches =
  (patches: Patch[]): Feature =>
  (intent) =>
    merge(patches.filter(needed(intent)).map((patch) => fragmentOf(patch, intent)));

/**
 * The patches each device gets, as far as the intent decides: its role and
 * the intent's settings. `only` is what the device itself still decides
 * (model, release), empty when nothing does.
 */
export const patchesFor = (patches: Patch[], intent: Intent) =>
  intent.hardware.map((device) => ({
    device: device.name,
    patches: patches
      .filter(needed(intent))
      .filter((p) => !p.target.roles || p.target.roles.includes(device.role))
      .map(({ id, why, upstream, target }) => ({ id, why, upstream, only: describeTarget(target) })),
  }));
