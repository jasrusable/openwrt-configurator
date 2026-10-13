// What each intent setting is called and what it does, for people: a bound
// field's row shows its label and description (a page passes its own only
// where the context calls for other words), and the provision page explains
// a change with them. Patterns use * for a list index; a pattern for a list
// item names the item from its value. Where a setting's effect depends on
// others (roaming assistance on Steering), its explainer is a function of
// the intent, and its numbers come from where the compiler takes them, so
// the text says what the devices will do. Each feature keeps its own
// (<feature>/fields.ts); here they are gathered and looked up.
import type { FieldInfo } from "./feature";
import { featureModules } from "./modules";
import { matchPattern } from "./paths";
import { marksAt, markText } from "./patches/marks";
import type { Intent } from "./schema";

export type { FieldInfo };

/**
 * A field as the registry looks it up: by a path known only at run time
 * (a diff's, a page's), so its label and explainer take loose values. Each
 * feature writes its fields typed by their own path (feature.ts).
 */
export type FieldAtRunTime = Omit<FieldInfo, "path" | "label" | "explain"> & {
  path: string;
  label: string | ((item: unknown) => string);
  explain?: string | ((intent: Intent, at: string[]) => string);
};

export const fields: FieldInfo[] = featureModules.flatMap((feature) => feature.fields ?? []);
const lookup = fields as unknown as FieldAtRunTime[];

/** What a setting is called and does, by its path (each step a key or a list index). */
export const fieldInfo = (path: readonly string[]): FieldAtRunTime | undefined => lookup.find((field) => matchPattern(field.path, path));

/**
 * A setting's explainer, then what any patch the intent needs says about it
 * (src/intent/patches): where it holds, and the issue to read, so a setting a
 * patch holds off somewhere says so rather than being overridden silently.
 */
export const explainFor = (path: readonly string[], intent: Intent) => {
  const info = fieldInfo(path);
  const own = typeof info?.explain === "function" ? info.explain(intent, matchPattern(info.path, path)!) : info?.explain;
  // Each patch's once, though it marks the setting twice (a section per band).
  const notes = [...new Set(marksAt(intent, path).map(markText))];
  return [own, ...notes].filter(Boolean).join(" ") || undefined;
};
