// The saved settings, loaded the one way every part of the app that acts on
// them does: the intent file, its secrets resolved, compiled (loadConfig),
// as a Result whose failure says what went wrong, so a page can say it and
// the API answer with the right status. And the file as written, for what
// works on any intent, valid or not (the editor, a diff, listing hardware).
import { formatOf, migrateIntent } from "./intent/migrations";
import { Intent, intentSchema, intentVersion } from "./intent/schema";
import { holdsSecretRefs, intentRefsRefused, loadConfig, LoadedConfig } from "./loadConfig";
import { parseConfigJson } from "./parseJson";
import { fileErrorCode, Platform } from "./platform";
import { fail, Problem, problem } from "./problem";
import { err, messageOf, ok, Result } from "./result";

export type SavedSettings = LoadedConfig & { intent: Intent };

/**
 * Why an intent file could not be read as written, of the kind it is: missing
 * (not-found), unreadable here (internal: this machine's, not a device's),
 * else not valid (conflict). The file error's code says which (src/platform.ts).
 */
const readProblem = (path: string, thrown: unknown): Problem => {
  const code = fileErrorCode(thrown);
  if (code === "ENOENT") return problem("not-found", `No settings are saved at ${path} yet.`);
  if (code) return problem("internal", `The settings file cannot be read: ${messageOf(thrown)}`);
  return problem("conflict", `The saved settings are not valid: ${messageOf(thrown)}`);
};

/**
 * The saved intent, its secrets resolved, compiled and checked (loadConfig,
 * which sets each failure's kind where it happens): what may be applied or
 * read against. Saved settings that are not valid cannot be acted on: a conflict.
 */
export const loadSettings = async (intentPath: string, platform: Platform): Promise<Result<SavedSettings, Problem>> => {
  const loaded = await loadConfig({ path: intentPath, platform });
  if (!loaded.ok) {
    const { kind, message } = loaded.error;
    if (kind === "not-found") return fail("not-found", `No settings are saved at ${intentPath} yet.`);
    return kind === "invalid" ? fail("conflict", `The saved settings are not valid: ${message}`) : loaded;
  }
  const { intent } = loaded.value;
  if (!intent) return fail("conflict", "The saved settings are not an intent file.");
  return ok({ ...loaded.value, intent });
};

/**
 * An intent file as written: in the current format, with the schema's
 * defaults filled in when it is valid (so a diff never reports a default as
 * a change); why not, when it is missing, unreadable or not JSON.
 */
export const readIntentFile = (files: Pick<Platform, "readTextFile">, path: string): Result<unknown, Problem> => {
  try {
    const intent = migrateIntent(parseConfigJson(files.readTextFile(path), path));
    if (holdsSecretRefs(intent)) throw new Error(intentRefsRefused);
    const parsed = intentSchema.safeParse(intent);
    return ok(parsed.success ? parsed.data : intent);
  } catch (thrown) {
    return err(readProblem(path, thrown));
  }
};

/** The intent file as written, if there is one that reads (see readIntentFile). */
export const intentFileOrNothing = (files: Pick<Platform, "readTextFile">, path: string): unknown => {
  const read = readIntentFile(files, path);
  return read.ok ? read.value : undefined;
};

/** Where the file a write replaced is kept, beside it. */
export const backupPath = (path: string) => `${path}.bak`;

/**
 * The intent file written, owner-only (it holds passwords). The file it
 * replaces is kept as `.bak` when `keepOld` says so: a restore or a reset
 * replaces everything, and a file in an older format is not written over
 * unseen (it was migrated in memory when read).
 */
export const writeIntentFile = (
  files: Pick<Platform, "readTextFile" | "writeFileAtomic">,
  path: string,
  value: unknown,
  { keepOld }: { keepOld: "always" | "older-format" }
) => {
  const old = (() => {
    try {
      return files.readTextFile(path);
    } catch {
      return undefined;
    }
  })();
  const olderFormat = () => {
    try {
      return (formatOf(parseConfigJson(old!, path)) ?? intentVersion) < intentVersion;
    } catch {
      return false;
    }
  };
  if (old !== undefined && (keepOld === "always" || olderFormat())) files.writeFileAtomic(backupPath(path), old, 0o600);
  files.writeFileAtomic(path, JSON.stringify(value, null, 2) + "\n", 0o600);
};
