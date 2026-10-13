// Paths into the intent, as types and at run time. A path is dotted:
// "networks.1.name" names one value; a pattern, with * for any list index
// (or any key of an object whose keys are alike, as the radios' bands are),
// names a setting wherever it occurs: "networks.*.name". Rules and fields
// are keyed by patterns, typed, so a mistyped or renamed key fails to
// compile; the UI's fields by paths.
import type { Intent } from "./schema";

type Limit = 8;

/** Every dotted path into T: "networks", "networks.1", "networks.1.name"... */
export type PathsOf<T, Depth extends unknown[] = []> = Depth["length"] extends Limit
  ? never
  : T extends readonly (infer U)[]
    ? `${number}` | `${number}.${PathsOf<NonNullable<U>, [...Depth, 1]>}`
    : T extends object
      ? {
          [K in keyof T & string]: K | `${K}.${PathsOf<NonNullable<T[K]>, [...Depth, 1]>}`;
        }[keyof T & string]
      : never;

/** The value at a path, as a type. */
export type ValueAt<T, P extends string> = P extends `${infer K}.${infer R}`
  ? T extends readonly (infer U)[]
    ? ValueAt<NonNullable<U>, R>
    : K extends keyof T
      ? ValueAt<NonNullable<T[K]>, R>
      : never
  : T extends readonly (infer U)[]
    ? U
    : P extends keyof T
      ? T[P]
      : never;

/** Whether every key of T holds the same kind of value (the radios' bands): then * may stand for any. */
type Alike<T> = {
  [K in keyof T]-?: [NonNullable<T[K]>] extends [NonNullable<T[keyof T]>]
    ? [NonNullable<T[keyof T]>] extends [NonNullable<T[K]>]
      ? true
      : false
    : false;
}[keyof T] extends true
  ? true
  : false;

/** Every pattern into T: a key, or * for a list's items or an object's alike keys. */
export type PatternsOf<T, Depth extends unknown[] = []> = Depth["length"] extends Limit
  ? never
  : T extends readonly (infer U)[]
    ? "*" | `*.${PatternsOf<NonNullable<U>, [...Depth, 1]>}`
    : T extends object
      ?
          | {
              [K in keyof T & string]: K | `${K}.${PatternsOf<NonNullable<T[K]>, [...Depth, 1]>}`;
            }[keyof T & string]
          | (Alike<T> extends true ? "*" | `*.${PatternsOf<NonNullable<T[keyof T]>, [...Depth, 1]>}` : never)
      : never;

/** One step down a pattern: a key, or * for a list's items or an object's alike keys. */
type Step<T, K extends string> = T extends readonly (infer U)[] ? U : K extends "*" ? T[keyof T] : K extends keyof T ? T[K] : never;

/** The value a pattern names (each * any list index, or any of alike keys). */
export type PatternValue<T, P extends string> = P extends `${infer K}.${infer R}` ? PatternValue<NonNullable<Step<T, K>>, R> : Step<T, P>;

/** What each * of a pattern matches, in order: a list index (as text) or one of alike keys. */
export type StarsOf<T, P extends string> = P extends `${infer K}.${infer R}`
  ? [...Star<T, K>, ...StarsOf<NonNullable<Step<T, K>>, R>]
  : Star<T, P>;
type Star<T, K extends string> = K extends "*" ? [T extends readonly unknown[] ? string : keyof T & string] : [];

/** A setting, wherever it occurs: what rules (choices.ts) and fields (fields.ts) are keyed by. */
export type SettingPath = PatternsOf<Intent>;

/** What the * parts of `pattern` matched in `path`, or undefined if it does not match. */
export const matchPattern = (pattern: string, path: readonly string[]): string[] | undefined => {
  const parts = pattern.split(".");
  if (parts.length !== path.length) return undefined;
  return parts.reduce<string[] | undefined>(
    (at, part, i) => (at === undefined ? undefined : part === "*" ? [...at, path[i]] : part === path[i] ? at : undefined),
    []
  );
};
