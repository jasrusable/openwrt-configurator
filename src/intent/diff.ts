// What changes between two intents, in people's terms: which setting, from
// what to what, and what it means. Secrets are never included, only that
// they changed.
import { fieldInfo } from "./fields";

export type Change = {
  path: string;
  /** Like ["Wi-Fi", "“Home”", "Password"]. */
  label: string[];
  kind: "added" | "removed" | "changed";
  before?: string;
  after?: string;
  description?: string;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

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
  const label: string[] = [];
  let b: any = before;
  let a: any = after;
  path.forEach((part, i) => {
    b = b?.[part];
    a = a?.[part];
    const info = fieldInfo(path.slice(0, i + 1));
    if (!info) return;
    label.push(typeof info.label === "function" ? info.label(a ?? b) : info.label);
  });
  return label;
};

export const diffIntent = (before: unknown, after: unknown): Change[] => {
  const changes: Change[] = [];
  const walk = (b: unknown, a: unknown, path: string[]) => {
    if (equal(b, a)) return;
    const info = fieldInfo(path);
    // Lists of things (Wi-Fi networks, devices) compare item by item.
    if (Array.isArray(b) && Array.isArray(a) && fieldInfo([...path, "*"])) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        walk(b[i], a[i], [...path, String(i)]);
      }
      return;
    }
    // A secret object changes as a whole; anything else, field by field.
    if (isObject(b) && isObject(a) && !info?.secret) {
      const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])];
      // A variant switch (DHCP to PPPoE) is one change, not three.
      if (b.type !== undefined && b.type !== a.type) {
        changes.push(change(b, a, path));
        return;
      }
      keys.forEach((key) => walk(b[key], a[key], [...path, key]));
      return;
    }
    changes.push(change(b, a, path));
  };
  const change = (b: unknown, a: unknown, path: string[]): Change => {
    const info = fieldInfo(path);
    return {
      path: path.join("."),
      label: labelFor(path, before, after),
      kind: b === undefined ? "added" : a === undefined ? "removed" : "changed",
      before: display(b, path),
      after: display(a, path),
      description: info?.description,
    };
  };
  walk(before, after, []);
  return changes;
};
