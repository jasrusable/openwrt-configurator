// What changes between two intents, in people's terms: which setting, from
// what to what, and what it means. Secrets are never included, only that
// they changed.
import { fieldInfo } from "./fields";
import { isPlainObject as isObject, sameJson as equal } from "../json";

export type Change = {
  path: string;
  /** Like ["Wi-Fi", "“Home”", "Password"]. */
  label: string[];
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
  description?: string;
};


const display = (value: unknown, path: string[]): string | undefined => {
  const info = fieldInfo(path);
  if (value === undefined) return undefined;
  // A secret only ever reads as changed: no value, masked or not.
  if (info?.secret) return undefined;
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (isObject(value)) {
    return typeof value.type === "string" ? value.type : undefined;
  }
  return info?.unit ? `${value} ${info.unit}` : String(value);
};

/** A setting's path in people's terms, like ["Wi-Fi", "“Home”", "Password"]. */
export const describePath = (path: string[], intent: unknown) => labelFor(path, intent, intent);

/** The human name of each step of a path, skipping steps with none. */
const labelFor = (path: string[], before: unknown, after: unknown) => {
  /** The value `steps` into `value`, whatever it is. */
  const at = (value: unknown, steps: string[]) =>
    steps.reduce<unknown>((node, step) => (isObject(node) || Array.isArray(node) ? (node as Record<string, unknown>)[step] : undefined), value);
  return path.flatMap((_, i) => {
    const steps = path.slice(0, i + 1);
    const info = fieldInfo(steps);
    if (!info) return [];
    return [typeof info.label === "function" ? info.label(at(after, steps) ?? at(before, steps)) : info.label];
  });
};

/** What a list item is, to pair it across two lists: its id, else its name. */
const keyOf = (item: unknown) => {
  if (!isObject(item)) return undefined;
  const key = item.id ?? item.name ?? item.ssid;
  return typeof key === "string" && key ? key : undefined;
};

export const diffIntent = (before: unknown, after: unknown): Change[] => {
  const changes: Change[] = [];
  // `path` is where it is after, `from` where it was before: a list item
  // keeps its identity when items before it come or go.
  const walk = (b: unknown, a: unknown, path: string[], from: string[]) => {
    if (equal(b, a)) return;
    const info = fieldInfo(path);
    // Lists of things (Wi-Fi networks, devices) compare item by item, each
    // paired with itself by its id or name, else by its place.
    if (Array.isArray(b) && Array.isArray(a) && fieldInfo([...path, "*"])) {
      // First by identity; then what is left by place (a renamed item).
      const pairOf = new Map<number, number>();
      a.forEach((item, i) => {
        const key = keyOf(item);
        const j = key === undefined ? -1 : b.findIndex((o, k) => ![...pairOf.values()].includes(k) && keyOf(o) === key);
        if (j >= 0) pairOf.set(i, j);
      });
      a.forEach((_, i) => {
        if (!pairOf.has(i) && i < b.length && ![...pairOf.values()].includes(i)) pairOf.set(i, i);
      });
      a.forEach((item, i) => {
        const j = pairOf.get(i);
        walk(j === undefined ? undefined : b[j], item, [...path, String(i)], [...from, String(j ?? i)]);
      });
      b.forEach((item, j) => {
        if (![...pairOf.values()].includes(j)) walk(item, undefined, [...path, String(j)], [...from, String(j)]);
      });
      return;
    }
    // A secret object changes as a whole; anything else, field by field.
    if (isObject(b) && isObject(a) && !info?.secret) {
      const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
      // A variant switch (DHCP to PPPoE) is one change, not three: its type's.
      if (b.type !== undefined && b.type !== a.type) {
        changes.push(change(b.type, a.type, [...path, "type"], [...from, "type"]));
        return;
      }
      keys.forEach((key) => walk(b[key], a[key], [...path, key], [...from, key]));
      return;
    }
    changes.push(change(b, a, path, from));
  };
  const change = (b: unknown, a: unknown, path: string[], from: string[]): Change => {
    const info = fieldInfo(path);
    return {
      path: (a === undefined ? from : path).join("."),
      // Named as it is now, or as it was when it is gone.
      label: a === undefined ? labelFor(from, before, before) : labelFor(path, after, after),
      kind: b === undefined ? "added" : a === undefined ? "removed" : "changed",
      before: display(b, path),
      after: display(a, path),
      description: info?.description,
    };
  };
  walk(before, after, [], []);
  return changes;
};
