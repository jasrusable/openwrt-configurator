// What a setting may be set to, given the rest of the intent: one rule per
// constraint, each saying why a value is not available. The schema reports
// a value a rule refuses, with the rule's own words; the UI's fields look
// up the rules for their path and grey the value out, with the same words
// in a tooltip. Where refusing would leave no way forward (a network needs
// exactly one router), choosing the value instead swaps: it also changes
// what else it must, so the settings never pass through a broken state.
// Free-text values (an address, a name) are checked by the schema alone.
// Each feature keeps its own rules (<feature>/rules.ts); here they are
// gathered, in the features' order (modules.ts), and looked up.
import type { Choice, Swap } from "./feature";
import { featureModules } from "./modules";
import { matchPattern, type PathsOf } from "./paths";
import type { Intent } from "./schema";

export type { Choice, Swap };

type Reason = string | false | undefined | null | 0;

/**
 * A rule as the registry runs it: looked up by a path known only at run
 * time, so its value and `at` are as loose as that path. Each feature
 * writes its rules typed by their own path (feature.ts).
 */
type RuleAtRunTime = {
  path: string;
  values?: readonly unknown[];
  unavailable?: (intent: Intent, at: string[], value: unknown) => Reason;
  refuses?: boolean;
  swap?: (intent: Intent, at: string[], value: unknown) => Swap | undefined;
};

export const choices: Choice[] = featureModules.flatMap((feature) => feature.rules ?? []);
const rules = choices as unknown as RuleAtRunTime[];

/** Whether a setting is used: set, and not off or empty. */
export const inUse = (value: unknown) =>
  value !== undefined && value !== false && !(Array.isArray(value) && value.length === 0);

/** Whether a setting holds a value: equal to it, or containing it (a list). */
const holds = (value: unknown, option: unknown) =>
  Array.isArray(value) ? value.includes(option) : value === option;

/** Every place a rule's path matches in the intent: its path, what each * matched, its value. */
const expand = (intent: unknown, pattern: string) =>
  pattern.split(".").reduce<{ path: string[]; at: string[]; value: unknown }[]>(
    (places, part) =>
      places.flatMap(({ path, at, value }) => {
        if (value === null || typeof value !== "object") return [];
        // A named key that is missing still has a place, holding undefined:
        // a rule about the unset value (the WAN port) applies there too.
        const keys = part === "*" ? Object.keys(value) : [part];
        return keys.map((key) => ({
            path: [...path, key],
            at: part === "*" ? [...at, key] : at,
            value: (value as Record<string, unknown>)[key],
          }));
      }),
    [{ path: [], at: [], value: intent }]
  );

const reasonOf = (reason: Reason) => (reason ? reason : undefined);

/** What the rules refuse in an intent, for the schema to report. */
export const choiceIssues = (intent: Intent) =>
  rules
    .filter((choice) => choice.unavailable && choice.refuses !== false)
    .flatMap((choice) =>
      expand(intent, choice.path).flatMap(({ path, at, value }) => {
        // Its values the setting holds; for the setting as a whole, each item it holds (or its one value).
        const used = choice.values ? choice.values.filter((v) => holds(value, v)) : inUse(value) ? [value].flat() : [];
        const reason = used.map((v) => reasonOf(choice.unavailable!(intent, at, v))).find(Boolean);
        return reason ? [{ path: path.map((p) => (/^\d+$/.test(p) ? Number(p) : p)), message: reason }] : [];
      })
    );

export type Availability = {
  /** Why the setting as a whole is not available, if it is not, and whether the schema refuses it. */
  unavailable?: { reason: string; refuses: boolean };
  /** For one value: why it is not available, or what choosing it also changes. */
  option: (value: unknown) => { unavailable?: string; swap?: Swap };
};

/** The rules for one setting, by its path (like "wifi.radios.2g.width"), given the rest of the intent. */
export const availability = (intent: Intent, path: PathsOf<Intent>): Availability => {
  const matching = rules.flatMap((choice) => {
    const at = matchPattern(choice.path, path.split("."));
    return at ? [{ choice, at }] : [];
  });
  return {
    unavailable: matching
      .filter(({ choice }) => !choice.values && choice.unavailable)
      .map(({ choice, at }) => {
        const reason = reasonOf(choice.unavailable!(intent, at, undefined));
        return reason ? { reason, refuses: choice.refuses !== false } : undefined;
      })
      .find(Boolean),
    option: (value) => {
      const about = matching.filter(({ choice }) => choice.values?.includes(value));
      return {
        unavailable: about
          .filter(({ choice }) => choice.unavailable)
          .map(({ choice, at }) => reasonOf(choice.unavailable!(intent, at, value)))
          .find(Boolean),
        swap: about.map(({ choice, at }) => choice.swap?.(intent, at, value)).find(Boolean),
      };
    },
  };
};
