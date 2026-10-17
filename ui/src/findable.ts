// What ⌘K finds (Finder.tsx): every setting, by its label, what it does and
// what OpenWrt calls it (so "htmode" finds Channel width), each list's items
// by name, the pages, the devices and the clients. A setting is listed once
// per item it is for ("Wi-Fi › Home › Password"), only where the settings
// hold the part it belongs to (a PPPoE username only on a PPPoE line); its
// value is never shown or searched. Pure, so it is tested without a page.
import { fields, type FieldAtRunTime } from "../../src/intent/fields";
import { placeName, type Place } from "../../src/intent/places";
import type { Intent } from "../../src/intent/schema";
import { settingUrl, whereIs } from "./settingPages";

export type Entry = {
  id: string;
  /** Where it is: Settings, Status, Device, Client. */
  group: "Settings" | "Status" | "Device" | "Client";
  title: string;
  /** Where it is within its group: its page, then the items it is within. */
  context?: string;
  detail?: string;
  url: string;
  /** Everything it is found by, lower case. */
  words: string;
};

const at = (value: unknown, part: string) => (value !== null && typeof value === "object" ? (value as Record<string, unknown>)[part] : undefined);

/** Every concrete path a pattern stands for in `intent`, a `*` taking each index or key there. */
const expand = (pattern: string[], value: unknown, done: string[] = []): string[][] => {
  if (!pattern.length) return [done];
  const [part, ...rest] = pattern;
  if (part !== "*") return expand(rest, at(value, part), [...done, part]);
  const keys = Array.isArray(value) ? value.map((_, i) => String(i)) : value && typeof value === "object" ? Object.keys(value) : [];
  return keys.flatMap((key) => expand(rest, at(value, key), [...done, key]));
};

const valueAt = (intent: Intent, path: string[]) => path.reduce<unknown>(at, intent);

const registry = fields as unknown as FieldAtRunTime[];

/** A list item's name ("Home"), by the field for the item itself (its label a function of it). */
const itemName = (intent: Intent, path: string[]) => {
  const field = registry.find((f) => typeof f.label === "function" && f.path.split(".").length === path.length && f.path.split(".").every((p, i) => p === "*" || p === path[i]));
  const label = field?.label;
  return typeof label === "function" ? label(valueAt(intent, path)) : undefined;
};

const lower = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ").toLowerCase();

/** Every setting there is in `intent`, each where it is edited. */
export const settingEntries = (intent: Intent): Entry[] =>
  registry.flatMap((field) => {
    const pattern = field.path.split(".");
    return expand(pattern, intent).flatMap((path) => {
      const parent = path.slice(0, -1);
      // Only where the part it belongs to is set: no PPPoE username on a DHCP line.
      if (parent.length && valueAt(intent, parent) === undefined) return [];
      const dotted = path.join(".");
      const url = settingUrl(dotted);
      const page = whereIs(dotted)?.page;
      if (!url || !page) return [];
      // The names of the items it is within: "Home" for wifi.networks.0.password.
      const items = pattern.flatMap((p, i) => (p === "*" ? [itemName(intent, path.slice(0, i + 1))] : [])).filter((n): n is string => !!n);
      const isItem = pattern[pattern.length - 1] === "*";
      const title = isItem ? items.pop() : typeof field.label === "string" ? field.label : undefined;
      if (!title) return [];
      // The section it is in, where that is a setting of its own ("This app's login" for its password).
      const section = pattern.length > 2 && !isItem ? registry.find((f) => f.path === pattern.slice(0, -1).join(".") && typeof f.label === "string" && pattern[pattern.length - 2] !== "*")?.label : undefined;
      const context = [placeName(page as Place), ...items, typeof section === "string" ? section : undefined].filter(Boolean).join(" › ");
      return [
        {
          id: `setting:${dotted}`,
          group: "Settings" as const,
          title,
          context,
          ...(field.description ? { detail: field.description } : {}),
          url,
          words: lower(title, context, field.description, field.openwrt),
        },
      ];
    });
  });

/**
 * The entries for `query`: every word in it found, the ones whose title
 * starts with it first, then whose title holds it, then the rest; each kind
 * in the order given. Empty: nothing (the pages are shown instead).
 */
export const find = (entries: Entry[], query: string, max = 40): Entry[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const score = (e: Entry) => {
    const title = e.title.toLowerCase();
    return title === q ? 0 : title.startsWith(q) ? 1 : title.includes(q) ? 2 : words.every((w) => title.includes(w)) ? 3 : 4;
  };
  return entries
    .filter((e) => words.every((w) => e.words.includes(w)))
    .map((e, i) => ({ e, i, s: score(e) }))
    .sort((a, b) => a.s - b.s || a.i - b.i)
    .slice(0, max)
    .map(({ e }) => e);
};
