// Small helpers over plain JSON values, shared so each is written once.

/** A plain object: not null, not an array. */
export const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** JSON with every object's keys sorted: equal values compare equal however they were built. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) => (isPlainObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v)) ??
  "undefined";

/** Whether two JSON values are equal, key order aside. */
export const sameJson = (a: unknown, b: unknown) => a === b || canonical(a) === canonical(b);
