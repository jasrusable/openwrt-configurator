// A three-way merge of intents: edits made over `base` (mine) replayed onto
// a newer `base` saved elsewhere (theirs). Used when the file changed while
// someone was editing it, so saving keeps both their edits and the other
// change. Where both changed the same setting, the edit being made wins.

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** JSON with sorted keys: equal values compare equal however they were built. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v
  ) ?? "undefined";

const same = (a: unknown, b: unknown) => a === b || canonical(a) === canonical(b);

const idOf = (item: unknown) =>
  isObject(item) && typeof item.id === "string" && item.id ? item.id : undefined;

/** Lists whose items all carry an id (networks, lines, VPN clients) merge item by item. */
const keyed = (...lists: unknown[][]) => lists.every((list) => list.every((item) => idOf(item) !== undefined));

const mergeLists = (base: unknown[], mine: unknown[], theirs: unknown[]): unknown[] => {
  if (keyed(base, mine, theirs)) {
    const byId = (list: unknown[]) => new Map(list.map((item) => [idOf(item)!, item]));
    const b = byId(base);
    const m = byId(mine);
    const t = byId(theirs);
    // Their order, each item merged; an item one side removed stays removed
    // unless the other side changed it; then items only mine added.
    const kept = theirs.flatMap((item) => {
      const id = idOf(item)!;
      if (!m.has(id)) return b.has(id) && same(b.get(id), item) ? [] : [item];
      return [b.has(id) ? merge3(b.get(id), m.get(id), item) : m.get(id)];
    });
    const added = mine.filter((item) => {
      const id = idOf(item)!;
      if (t.has(id)) return false;
      return !b.has(id) || !same(b.get(id), item);
    });
    return [...kept, ...added];
  }
  if (base.length === mine.length && base.length === theirs.length) {
    return base.map((item, i) => merge3(item, mine[i], theirs[i]));
  }
  return mine;
};

export const merge3 = <T>(base: unknown, mine: T, theirs: unknown): T => {
  if (same(mine, base)) return theirs as T;
  if (same(theirs, base) || same(mine, theirs)) return mine;
  if (isObject(base) && isObject(mine) && isObject(theirs)) {
    const keys = [...new Set([...Object.keys(theirs), ...Object.keys(mine)])];
    return Object.fromEntries(
      keys
        .map((key) => [key, merge3(base[key], mine[key], theirs[key])] as const)
        .filter(([, value]) => value !== undefined)
    ) as T;
  }
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs)) {
    return mergeLists(base, mine, theirs) as T;
  }
  return mine;
};
