// System › Backup: the settings file downloaded as stored, and replaced by a
// backup, by the defaults, or (with none saved yet) by a new network. Each
// replacement is reviewed before it is written, the same way: migrated to
// this app's format, checked against the schema, and what it changes in the
// saved settings listed. Writing it never applies anything: Save and Apply
// does. An intent holds plain values: a backup with `$secret` refs (a
// low-level file's feature) is refused.
import { diffIntent, Change } from "./intent/diff";
import { checkCompiles } from "./intent/compile";
import { formatOf, migrate } from "./intent/migrations";
import { Intent, intentSchema, intentVersion } from "./intent/schema";
import { resetIntent, StarterChoices, starterIntent } from "./intent/starter";
import { holdsSecretRefs, intentRefsRefused } from "./loadConfig";
import { parseConfigJson } from "./parseJson";
import { Platform } from "./platform";
import { fail, Problem } from "./problem";
import { messageOf, ok, Result } from "./result";
import { readIntentFile, writeIntentFile } from "./settings";

/** What replaces the saved settings. */
export type BackupSource =
  | { from: "file"; text: string }
  | { from: "defaults" }
  | { from: "new"; choices: StarterChoices };

export type BackupReview = {
  /** The backup's format, when older than this app's: it was upgraded. */
  upgradedFrom?: number;
  /** The backup is of another network: its name. */
  otherNetwork?: string;
  /** Why it cannot be written, setting by setting. */
  issues: { path: string; message: string }[];
  /** What it changes in the saved settings (none when nothing is saved yet). */
  changes: Change[];
};

type Json = Record<string, any>;
type Files = Pick<Platform, "readTextFile" | "writeFileAtomic">;

/** A download's name: the network's, and the day. */
export const backupFileName = (name: string, at: Date) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "network"}-settings-${at.toISOString().slice(0, 10)}.json`;

/** Which network settings are of: the site id their derived ids grow from, else the name. */
const siteOf = (json: unknown) => (json as Json)?.system?.site_id ?? (json as Json)?.system?.name;

/**
 * The saved file: whether there is one, and what it says when it reads. One
 * that does not read (not JSON, or holding refs) can still be replaced: that
 * is what a restore is for.
 */
const savedFile = (files: Files, path: string) => {
  const read = readIntentFile(files, path);
  return { exists: read.ok || read.error.kind !== "not-found", read };
};

/** A file's text as an intent in this app's format, with the format it came in. */
const fromText = (text: string): Result<{ json: unknown; from: number }, Problem> => {
  let parsed: unknown;
  try {
    parsed = parseConfigJson(text);
  } catch (thrown) {
    return fail("invalid", `This file is not JSON: ${messageOf(thrown)}`);
  }
  const from = formatOf(parsed);
  if (from === undefined) return fail("invalid", "This file is not a settings backup: it says no format.");
  if (holdsSecretRefs(parsed)) return fail("invalid", intentRefsRefused);
  try {
    return ok({ json: migrate(parsed).value, from });
  } catch (thrown) {
    return fail("invalid", messageOf(thrown));
  }
};

/** What the source is, as an intent not yet checked. */
const candidateOf = (source: BackupSource, saved: ReturnType<typeof savedFile>): Result<{ json: unknown; from?: number }, Problem> => {
  switch (source.from) {
    case "file":
      return fromText(source.text);
    case "defaults": {
      if (!saved.exists) return fail("not-found", "No settings are saved yet: there is nothing to reset.");
      const valid = intentSchema.safeParse(saved.read.ok ? saved.read.value : undefined);
      return valid.success
        ? ok({ json: resetIntent(valid.data) })
        : fail("conflict", "The saved settings are not valid, so they cannot be reset: restore a backup instead.");
    }
    case "new":
      return saved.exists ? fail("conflict", "Settings are already saved here.") : ok({ json: starterIntent(source.choices) });
  }
};

export type ReviewInput = { source: BackupSource; files: Files; intentPath: string };

/** A source reviewed: what writing it would change, or why it cannot be written; and the file it would write. */
export const reviewBackup = ({ source, files, intentPath }: ReviewInput): Result<{ review: BackupReview; write?: Intent }, Problem> => {
  const saved = savedFile(files, intentPath);
  const candidate = candidateOf(source, saved);
  if (!candidate.ok) return candidate;
  const { json, from } = candidate.value;
  // What is saved, when it reads: to name another network and list what changes.
  const before = saved.read.ok ? saved.read.value : undefined;
  const base: BackupReview = {
    ...(from !== undefined && from < intentVersion ? { upgradedFrom: from } : {}),
    ...(before !== undefined && siteOf(json) !== siteOf(before) ? { otherNetwork: String((json as Json)?.system?.name ?? "") } : {}),
    issues: [],
    changes: [],
  };
  const parsed = intentSchema.safeParse(json);
  if (!parsed.success) return ok({ review: { ...base, issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) } });
  const compiled = checkCompiles(parsed.data);
  if (!compiled.ok) return fail("internal", "These settings are valid but did not compile.", compiled.error.details);
  return ok({ review: { ...base, changes: before === undefined ? [] : diffIntent(before, parsed.data) }, write: parsed.data });
};

/** A source written as the saved settings, once its review allows it; the file it replaces kept as `.bak`. */
export const restoreBackup = (input: ReviewInput): Result<BackupReview, Problem> => {
  const reviewed = reviewBackup(input);
  if (!reviewed.ok) return reviewed;
  const { review, write } = reviewed.value;
  if (write === undefined) return fail("invalid", "Some settings need fixing.", { details: { review } });
  writeIntentFile(input.files, input.intentPath, write, { keepOld: "always" });
  return ok(review);
};
