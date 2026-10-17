// The saved settings, loaded the one way every part of the app that acts on
// them does: the intent file, its secrets resolved, compiled (loadConfig),
// as a Result whose failure says what went wrong, so a page can say it and
// the API answer with the right status. And the file as written, for what
// works on any intent, valid or not (the editor, a diff, listing hardware).
import { checkCompiles } from "./intent/compile";
import { formatOf, migrateIntent } from "./intent/migrations";
import { Intent, intentSchema, intentShape, intentVersion } from "./intent/schema";
import { issuesAt } from "./intent/issues";
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
 * a change); why not, when it is missing, unreadable, not JSON, from a newer
 * app, or holding `$secret` refs.
 */
export const readIntentFile = (files: Pick<Platform, "readTextFile">, path: string): Result<unknown, Problem> => {
  let parsed: unknown;
  try {
    parsed = parseConfigJson(files.readTextFile(path), path);
  } catch (thrown) {
    return err(readProblem(path, thrown));
  }
  const intent = migrateIntent(parsed);
  if (!intent.ok) return fail("conflict", `The saved settings are not valid: ${intent.error.message}`);
  if (holdsSecretRefs(intent.value)) return fail("conflict", `The saved settings are not valid: ${intentRefsRefused}`);
  // Defaults applied wherever the shape holds, so an editor never meets a
  // missing default: only the checks across settings may still fail.
  const shaped = intentShape.safeParse(intent.value);
  return ok(shaped.success ? shaped.data : intent.value);
};

/** The intent file as written, if there is one that reads (see readIntentFile). */
export const intentFileOrNothing = (files: Pick<Platform, "readTextFile">, path: string): unknown => {
  const read = readIntentFile(files, path);
  return read.ok ? read.value : undefined;
};

/**
 * Settings as they may be saved: valid (else each issue at its path, as
 * `details.issues`) and compiling (else the compiler's fault: never saved,
 * so it shows here, not halfway through a run).
 */
export const checkedIntent = (input: unknown): Result<Intent, Problem> => {
  const parsed = intentSchema.safeParse(input);
  if (!parsed.success) return fail("invalid", "Some settings need fixing.", { details: { issues: issuesAt(parsed.error) } });
  const compiled = checkCompiles(parsed.data);
  return compiled.ok ? ok(parsed.data) : fail("internal", "The settings are valid but did not compile.", { details: compiled.error.details });
};

/** How many replaced files are kept beside the settings file. */
export const keptBackups = 5;

const splitPath = (path: string) => {
  const slash = path.lastIndexOf("/");
  const file = path.slice(slash + 1);
  return { dir: slash < 0 ? "." : path.slice(0, slash) || "/", stem: file.replace(/\.json$/, "") };
};

/**
 * Where a file replaced at `at` is kept: beside it, as
 * `<name>.<compact ISO time>.bak` (a name every `*.bak` ignore rule covers),
 * sorting oldest first.
 */
export const backupPath = (path: string, at: number) => {
  const { dir, stem } = splitPath(path);
  return `${dir}/${stem}.${new Date(at).toISOString().replace(/[-:]/g, "")}.bak`;
};

/** The replaced files kept for `path`, oldest first. */
export const backupsOf = (files: Pick<Platform, "listDir">, path: string) => {
  const { dir, stem } = splitPath(path);
  const isKept = (name: string) => name.startsWith(stem) && /^\.\d{8}T\d{6}\.\d{3}Z\.bak$/.test(name.slice(stem.length));
  return files
    .listDir(dir)
    .filter(isKept)
    .sort()
    .map((name) => `${dir}/${name}`);
};

export type IntentFiles = Pick<Platform, "readTextFile" | "writeFileAtomic" | "listDir" | "removeFile">;

/**
 * The intent file written, owner-only (it holds passwords), unless it
 * already says exactly that. The file it replaces is kept (`backupPath`,
 * owner-only, the newest `keptBackups`) when `keepOld` says so: a restore
 * or a reset replaces everything, and a file in an older format is not
 * written over unseen (it was migrated in memory when read).
 */
export const writeIntentFile = (
  files: IntentFiles,
  path: string,
  value: unknown,
  { keepOld, at }: { keepOld: "always" | "older-format"; at: number }
): Result<void, Problem> => {
  const text = JSON.stringify(value, null, 2) + "\n";
  const old = (() => {
    try {
      return files.readTextFile(path);
    } catch {
      return undefined;
    }
  })();
  if (old === text) return ok(undefined);
  const olderFormat = () => {
    try {
      return (formatOf(parseConfigJson(old!, path)) ?? intentVersion) < intentVersion;
    } catch {
      return false;
    }
  };
  try {
    if (old !== undefined && (keepOld === "always" || olderFormat())) {
      files.writeFileAtomic(backupPath(path, at), old, 0o600);
      backupsOf(files, path).slice(0, -keptBackups).forEach((kept) => files.removeFile(kept));
    }
    files.writeFileAtomic(path, text, 0o600);
    return ok(undefined);
  } catch (thrown) {
    // The disk's (a plain Error, from either platform: full, read-only, gone) is said; a bug is thrown on.
    if (thrown instanceof TypeError || thrown instanceof RangeError || thrown instanceof ReferenceError) throw thrown;
    return fail("internal", `The settings could not be saved: ${messageOf(thrown)}`);
  }
};
