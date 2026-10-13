// A feature (a folder here: system, internet, networks, wifi, …) brings its
// knowledge to the registries the rest of the app reads: its rules (what a
// setting may be, given the rest: choices.ts), its fields (what each setting
// is called and does: fields.ts), its checks across settings (schema.ts) and
// its compile steps (compile.ts). The types here are all a feature needs to
// write them; the registries import the features, never the other way.
import type { PatternValue, SettingPath, StarsOf } from "./paths";
import type { Fragment } from "../plan/types";
import type { Intent } from "./schema";

/** Report a problem at a setting's path, as the schema shows it. */
export type AddIssue = (path: (string | number)[], message: string) => void;

type Reason = string | false | undefined | null | 0;

/** One of a setting's values: an item, where the setting is a list. */
type Item<V> = NonNullable<V> extends readonly (infer U)[] ? U : V;

export type Swap = {
  /** What else changes, for the option's tooltip. */
  note: string;
  /** The intent with the value chosen and the rest changed to fit. */
  apply: (intent: Intent) => Intent;
};

/**
 * A rule for one setting, typed by its path: its values are the setting's
 * (each item, where the setting is a list), and `at` holds what each * in
 * the path matched (a list index, a band).
 */
export type ChoiceAt<P extends SettingPath, V = Item<PatternValue<Intent, P>>> = {
  /** The setting, as in fields.ts: each * matches a list index or a key (a band). */
  path: P;
  /** The values it is about (undefined among them: the setting unset); unset, the setting as a whole (in use when set, true or non-empty). */
  values?: readonly V[];
  /**
   * Why not, given the rest; nothing when allowed. `value`: one of `values`,
   * or for the setting as a whole each item it holds (none when a page asks
   * about the setting itself: a rule that reads it is one whose setting may
   * be unset anyway).
   */
  unavailable?: (intent: Intent, at: StarsOf<Intent, P>, value: V) => Reason;
  /**
   * Whether the schema refuses it too. False where the value is harmless
   * (ignored while unavailable) or another rule reports the same problem:
   * the UI still greys it out.
   */
  refuses?: boolean;
  /** Instead of refusing, choosing it also changes the rest to fit. */
  swap?: (intent: Intent, at: StarsOf<Intent, P>, value: V) => Swap | undefined;
};

/** A rule for any setting: each path's own, so a rule's values and `at` follow from its path. */
export type Choice = { [P in SettingPath]: ChoiceAt<P> }[SettingPath];

/** What a setting is called and does, for people (fields.ts). */
export type FieldInfoAt<P extends SettingPath> = {
  path: P;
  /** Its name; for a list item, from the item's value. */
  label: string | ((item: PatternValue<Intent, P> | undefined) => string);
  description?: string;
  /** Never shown, even in a diff. */
  secret?: boolean;
  unit?: string;
  /** What OpenWrt calls it, for people who know LuCI: the foot of the setting's ⓘ tooltip. */
  openwrt?: string;
  /**
   * What it does on the devices, in more depth than its description: the
   * body of the tooltip. A function when it depends on other settings; `at`
   * holds what each * in the path matched.
   */
  explain?: string | ((intent: Intent, at: StarsOf<Intent, P>) => string);
};

export type FieldInfo = { [P in SettingPath]: FieldInfoAt<P> }[SettingPath];

/** A compile step, with its place among all the features' steps (lower first: section order on the devices). */
export type CompileStep = { order: number; compile: (intent: Intent) => Fragment };

export type FeatureModule = {
  rules?: Choice[];
  fields?: FieldInfo[];
  /** Rules across settings that no one field's schema can say, reported at the field they concern. */
  check?: (intent: Intent, issue: AddIssue) => void;
  compile?: CompileStep[];
};
