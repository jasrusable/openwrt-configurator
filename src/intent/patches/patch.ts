// A patch: a fix or tuning layered over what OpenWrt ships, kept apart from
// the features so it can be added for a model, a role or a release as
// problems are found, and dropped when OpenWrt fixes them upstream. It says
// why it exists, what it targets and, for a fix waiting on OpenWrt, the
// upstream issue; everything it emits applies only where it targets.
import { Feature, Fragment } from "../fragment";
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
    files?: Omit<NonNullable<Fragment["files"]>[number], ".if">[];
    config?: Fragment["config"];
    packages?: string[];
    /** configs_to_not_reset entries, like "?ubihealthd.*". */
    keeps?: string[];
  };
};

const list = (values: string[]) => `[${values.map((v) => `'${v}'`).join(", ")}]`;

/** The target as an engine condition. */
export const targetCondition = ({ models, roles, releases }: Target) =>
  [
    models && `device.model_id in ${list(models)}`,
    roles && `device.tag.role in ${list(roles)}`,
    releases?.from && `device.version >= '${releases.from}'`,
    releases?.before && `device.version < '${releases.before}'`,
  ]
    .filter(Boolean)
    .join(" AND ") || "*";

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
export const applyPatches = (patches: Patch[]): Feature => (intent) =>
  patches.filter(needed(intent)).reduce<Fragment>(
    (acc, patch) => {
      const when = targetCondition(patch.target);
      const { files = [], config = {}, packages = [], keeps = [] } = patch.apply(intent);
      return {
        files: [...(acc.files ?? []), ...files.map((f) => ({ ...f, ".if": when }))],
        package_profiles: [
          ...(acc.package_profiles ?? []),
          ...(packages.length ? [{ ".if": when, packages }] : []),
        ],
        configs_to_not_reset: [
          ...(acc.configs_to_not_reset ?? []),
          ...(keeps.length ? [{ ".if": when, configs: keeps }] : []),
        ],
        config: Object.entries(config).reduce(
          (merged, [key, types]) => ({
            ...merged,
            [key]: Object.entries(types).reduce(
              (sections, [type, sectionList]) => ({
                ...sections,
                [type]: [
                  ...(sections[type] ?? []),
                  ...sectionList.map((section) => ({ ...section, ".if": when })),
                ],
              }),
              merged[key] ?? {}
            ),
          }),
          acc.config ?? {}
        ),
      };
    },
    { files: [], package_profiles: [], configs_to_not_reset: [], config: {} }
  );

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
