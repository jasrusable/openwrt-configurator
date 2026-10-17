// What the engine does with a plan's values as it fits them to a device:
// finds and replaces placeholders, and writes a section once each value is
// concrete (or says which placeholder cannot stand where it is).
import { OpenWrtSection, UciScalar } from "./openWrtState";
import { isPlaceholder, Placeholder, Scalar, Value } from "../plan/types";
import { orderOptions } from "../plan/uciOrder";

/** The lowest number from `from` up that `taken` does not hold. */
export const firstFree = (taken: number[], from: number): number => (taken.includes(from) ? firstFree(taken, from + 1) : from);

export const sanitizeName = (name: string) => name.replace(/[^0-9a-z]/gi, "");

/** Every placeholder in a value: itself, or its list's. */
export const placeholdersIn = (value: Value): Placeholder[] =>
  Array.isArray(value) ? value.filter(isPlaceholder) : isPlaceholder(value) ? [value] : [];

/** A value with each placeholder replaced (a list item by one or more), the rest as it was. */
export const mapPlaceholders = (value: Value, fn: (p: Placeholder) => Value): Value =>
  Array.isArray(value)
    ? value.flatMap((item) => (isPlaceholder(item) ? [fn(item)].flat() : [item]))
    : isPlaceholder(value)
      ? fn(value)
      : value;

/** A list of plain values, from a value that holds no placeholder any more. */
export const strings = (value: Value | undefined): string[] =>
  value === undefined ? [] : (Array.isArray(value) ? value : [value]).filter((v): v is Scalar => !isPlaceholder(v)).map(String);

/** A placeholder left where nothing on this device resolves it. */
export const unresolvable =
  (hostname: string) =>
  (p: Placeholder): never => {
    throw new Error(`${hostname}: a ${p.kind} placeholder cannot be used there.`);
  };

/** A section as uci batch takes it: named, its options in order, every value concrete, or the section cannot be written here. */
export const writeSection = (hostname: string) => {
  const stuck = unresolvable(hostname);
  const concrete = (value: Value): UciScalar | UciScalar[] =>
    Array.isArray(value) ? value.map((item) => (isPlaceholder(item) ? stuck(item) : item)) : isPlaceholder(value) ? stuck(value) : value;
  return (configKey: string, type: string, name: string, options: Record<string, Value | undefined>): OpenWrtSection =>
    ({
      ".name": name,
      ...Object.fromEntries(
        Object.entries(orderOptions(configKey, type, options))
          .filter(([, value]) => value !== undefined)
          .map(([key, value]) => [key, concrete(value!)])
      ),
    }) as OpenWrtSection;
};
