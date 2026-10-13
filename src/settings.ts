// The saved settings, loaded the one way every part of the app that acts on
// them does: the intent file, its secrets resolved, compiled (loadConfig),
// as a Result whose failure says what went wrong, so a page can say it and
// the API answer with the right status. And the file as written, for what
// works on any intent, valid or not (the editor, a diff, listing hardware).
import { migrateIntent } from "./intent/migrations";
import { Intent, intentSchema } from "./intent/schema";
import { loadConfig, LoadedConfig } from "./loadConfig";
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
