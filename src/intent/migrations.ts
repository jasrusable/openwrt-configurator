// Older intent files, upgraded one version at a time to the current one. A
// file is migrated when read (in memory: startup, the CLI, a restored
// backup), and written in the current format only on its next save, the old
// file kept beside it as a timestamped `.bak` (settings.ts). A migration
// never drops a setting: it moves it to where it now lives. Until the first
// release the format stays at 1, the chain is empty and files are edited by
// hand.
import { intentVersion } from "./schema";
import { fail, Problem } from "../problem";
import { map, ok, Result } from "../result";

type Json = Record<string, any>;

/** `chain[n]` turns a version n file into version n + 1. */
export type Migrations = Record<number, (old: Json) => Json>;

export const migrations: Migrations = {};

/** The format an intent file says it is in; undefined when it is not one. */
export const formatOf = (json: unknown): number | undefined =>
  json && typeof json === "object" && typeof (json as Json).schema === "number" ? (json as Json).schema : undefined;

/**
 * The intent in the current format, and the format it was written in. Not
 * an intent file comes back as it is (the schema says what is wrong); one
 * from a newer app is refused, never half-read. A gap in the chain, or a
 * step that does not move exactly one version on, is a bug: thrown.
 */
export const migrate = (
  json: unknown,
  chain: Migrations = migrations,
  current: number = intentVersion
): Result<{ value: unknown; from?: number }, Problem> => {
  const from = formatOf(json);
  if (from === undefined) return ok({ value: json });
  if (!Number.isInteger(from) || from < 1) {
    return fail("invalid", `These settings say they are in format ${from}, which no version of this app wrote.`);
  }
  if (from > current) {
    return fail(
      "invalid",
      `These settings were made by a newer version of this app (format ${from}; this one reads up to ${current}). Update the app first.`
    );
  }
  const step = (intent: Json): Json => {
    if (intent.schema >= current) return intent;
    const next = chain[intent.schema];
    if (!next) throw new Error(`No migration from intent version ${intent.schema}.`);
    const moved = next(intent);
    if (moved.schema !== intent.schema + 1) {
      throw new Error(`The migration from intent version ${intent.schema} made version ${moved.schema}, not ${intent.schema + 1}.`);
    }
    return step(moved);
  };
  return ok({ value: step(json as Json), from });
};

/** The intent in the current format, whatever version it was written in. */
export const migrateIntent = (json: unknown): Result<unknown, Problem> => map(migrate(json), ({ value }) => value);
