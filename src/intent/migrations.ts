// Older intent files, upgraded one version at a time to the current one. A
// file is migrated when read (in memory: startup, the CLI, a restored
// backup), and written in the current format only on its next save, the old
// file kept beside it as `.bak` (settings.ts). A migration never drops a
// setting: it moves it to where it now lives. Until the first release the
// format stays at 1, the chain is empty and files are edited by hand.
import { intentVersion } from "./schema";

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
 * from a newer app is refused, never half-read.
 */
export const migrate = (
  json: unknown,
  chain: Migrations = migrations,
  current: number = intentVersion
): { value: unknown; from?: number } => {
  const from = formatOf(json);
  if (from === undefined) return { value: json };
  if (from > current) {
    throw new Error(
      `These settings were made by a newer version of this app (format ${from}; this one reads up to ${current}). Update the app first.`
    );
  }
  const step = (intent: Json): Json => {
    if (intent.schema >= current) return intent;
    const next = chain[intent.schema];
    if (!next) throw new Error(`No migration from intent version ${intent.schema}.`);
    return step(next(intent));
  };
  return { value: step(json as Json), from };
};

/** The intent in the current format, whatever version it was written in. */
export const migrateIntent = (json: unknown): unknown => migrate(json).value;
