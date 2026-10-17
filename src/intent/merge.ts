// A three-way merge of intents: edits made over `base` (mine) replayed onto
// a newer `base` saved elsewhere (theirs). Used when the file changed while
// someone was editing it, so saving keeps both their edits and the other
// change. Where both changed one setting differently, the edit being made
// wins and the setting is a conflict, for the page to say.
//
// A list's items are matched by what each one is (an id, else a natural key:
// a reservation's MAC, an SSID, a device's name; a plain value by itself),
// never by place: a place is not an item, so matching by it drops one side's
// item or edits the wrong one. Where items cannot be told apart, or one side
// removed (or renamed) an item the other changed, or the edit moved items,
// the edit's whole list is kept: a conflict.

import { canonical, isPlainObject as isObject, sameJson as same } from "../json";

export type Merged<T> = { value: T; conflicts: string[] };

/** The fields that say which item an item is, the most telling first. */
const keyFields = ["id", "mac", "ssid", "name"];

const isValue = (item: unknown) => !isObject(item) && !Array.isArray(item);

/** How the items of these lists are told apart: by a key every item has, told only once in each list. */
const identityOf = (lists: unknown[][]): ((item: unknown) => string) | undefined => {
  const items = lists.flat();
  const field = keyFields.find((f) => items.every((item) => isObject(item) && typeof item[f] === "string" && item[f] !== ""));
  const key = field ? (item: unknown) => (item as Record<string, string>)[field] : items.every(isValue) ? canonical : undefined;
  return key && lists.every((list) => new Set(list.map(key)).size === list.length) ? key : undefined;
};

const at = (path: string, key: string | number) => (path ? `${path}.${key}` : String(key));

const mergeLists = (base: unknown[], mine: unknown[], theirs: unknown[], path: string): Merged<unknown[]> => {
  const conflict = { value: mine, conflicts: [path] };
  const key = identityOf([base, mine, theirs]);
  if (!key) return conflict;
  const [b, m, t] = [base, mine, theirs].map((list) => new Map(list.map((item) => [key(item), item])));
  const changed = (side: Map<string, unknown>, k: string) => !same(b.get(k), side.get(k));
  const clash = [...b.keys()].some((k) => (!m.has(k) && t.has(k) && changed(t, k)) || (!t.has(k) && m.has(k) && changed(m, k)));
  // Their order is kept below, so an order the edit changed would be lost.
  const order = (list: unknown[]) => list.map(key).filter((k) => b.has(k) && m.has(k));
  if (clash || !same(order(base), order(mine))) return conflict;
  // Their order, each item merged (one removed on either side stays removed); then items only mine added.
  const kept = theirs.filter((item) => m.has(key(item)) || !b.has(key(item)));
  const merged = kept.map((item, i) => (m.has(key(item)) ? merge(b.get(key(item)), m.get(key(item)), item, at(path, i)) : { value: item, conflicts: [] }));
  const added = mine.filter((item) => !t.has(key(item)) && !b.has(key(item)));
  return { value: [...merged.map((r) => r.value), ...added], conflicts: merged.flatMap((r) => r.conflicts) };
};

const merge = (base: unknown, mine: unknown, theirs: unknown, path: string): Merged<unknown> => {
  if (same(mine, base)) return { value: theirs, conflicts: [] };
  if (same(theirs, base) || same(mine, theirs)) return { value: mine, conflicts: [] };
  if (isObject(base) && isObject(mine) && isObject(theirs)) {
    const keys = [...new Set([...Object.keys(theirs), ...Object.keys(mine)])];
    const parts = keys.map((key) => [key, merge(base[key], mine[key], theirs[key], at(path, key))] as const);
    return {
      value: Object.fromEntries(parts.filter(([, r]) => r.value !== undefined).map(([key, r]) => [key, r.value])),
      conflicts: parts.flatMap(([, r]) => r.conflicts),
    };
  }
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs)) return mergeLists(base, mine, theirs, path);
  return { value: mine, conflicts: [path] };
};

/** `mine` (edits over `base`) replayed onto `theirs`, and the paths where both changed and mine was kept. */
export const merge3 = <T>(base: unknown, mine: T, theirs: unknown): Merged<T> => merge(base, mine, theirs, "") as Merged<T>;
