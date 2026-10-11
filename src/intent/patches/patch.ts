// A patch: a fix or tuning layered over what OpenWrt ships, kept apart from
// the features so it can be added for a model, a role or a release as
// problems are found, and dropped when OpenWrt fixes them upstream. It says
// why it exists and when it applies; everything it emits applies only then.
import { Feature, Fragment } from "../fragment";
import { Intent } from "../schema";

export type Patch = {
  /** Short and stable, like "r6s-packet-steering". */
  id: string;
  /** The problem it fixes, and how it was seen (a measurement, a report). */
  why: string;
  /** The upstream issue or fix to watch: when it lands, the patch goes. */
  upstream?: string;
  /** An engine condition: a model, a role, a release (device.version). */
  when: string;
  /** What it changes, without conditions: the patch's `when` is added to each. */
  apply: (intent: Intent) => {
    files?: Omit<NonNullable<Fragment["files"]>[number], ".if">[];
    config?: Fragment["config"];
  };
};

/** A patch's changes, each made conditional on the patch's `when`. */
export const applyPatches = (patches: Patch[]): Feature => (intent) =>
  patches.reduce<Fragment>(
    (acc, patch) => {
      const { files = [], config = {} } = patch.apply(intent);
      return {
        files: [...(acc.files ?? []), ...files.map((f) => ({ ...f, ".if": patch.when }))],
        config: Object.entries(config).reduce(
          (merged, [key, types]) => ({
            ...merged,
            [key]: Object.entries(types).reduce(
              (sections, [type, list]) => ({
                ...sections,
                [type]: [
                  ...(sections[type] ?? []),
                  ...list.map((section) => ({ ...section, ".if": patch.when })),
                ],
              }),
              merged[key] ?? {}
            ),
          }),
          acc.config ?? {}
        ),
      };
    },
    { files: [], config: {} }
  );
