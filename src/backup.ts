// System › Backup: the settings file downloaded as stored, and replaced by a
// backup, by the defaults, or (with none saved yet) by a new network. Each
// replacement is reviewed before it is written, the same way: migrated to
// this app's format, checked as a save is (checkedIntent), and what it
// changes in the saved settings listed. Writing it never applies anything:
// Save and Apply does. An intent holds plain values: a backup with
// `$secret` refs (a low-level file's feature) is refused.
import { diffIntent, Change } from "./intent/diff";
import { formatOf, migrate } from "./intent/migrations";
import { Intent, intentVersion } from "./intent/schema";
import { newSiteId, siteOfJson } from "./intent/site";
import { resetIntent, StarterChoices, starterIntent } from "./intent/starter";
import { holdsSecretRefs, intentRefsRefused } from "./loadConfig";
import { parseConfigJson } from "./parseJson";
import { Platform } from "./platform";
import { fail, Problem } from "./problem";
import { map, messageOf, ok, Result } from "./result";
import { checkedIntent, IntentFiles, readIntentFile, writeIntentFile } from "./settings";

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

type Files = IntentFiles & Pick<Platform, "sha256">;

/** A download's name: the network's, and the day. */
export const backupFileName = (name: string, at: Date) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "network"}-settings-${at.toISOString().slice(0, 10)}.json`;

/**
 * The saved file, read once: whether there is one, what it says when it
 * reads, and its version (as the API gives it: "" when there is none), so a
 * write can name the exact text its review was of. One that does not read
 * (not JSON, newer, holding refs) can still be replaced: that is what a
 * restore is for.
 */
const savedFile = (files: Files, path: string) => {
  const raw = ((): { text: string } | { thrown: unknown } => {
    try {
      return { text: files.readTextFile(path) };
    } catch (thrown) {
      return { thrown };
    }
  })();
  const read = readIntentFile(
    {
      readTextFile: () => {
        if ("thrown" in raw) throw raw.thrown;
        return raw.text;
      },
    },
    path
  );
  return { exists: read.ok || read.error.kind !== "not-found", read, version: "text" in raw ? files.sha256(raw.text) : "" };
};

/** A file's text as an intent in this app's format, with the format it came in. */
const fromText = (text: string): Result<{ json: unknown; from?: number }, Problem> => {
  let parsed: unknown;
  try {
    parsed = parseConfigJson(text);
  } catch (thrown) {
    return fail("invalid", `This file is not JSON: ${messageOf(thrown)}`);
  }
  if (formatOf(parsed) === undefined) return fail("invalid", "This file is not a settings backup: it says no format.");
  if (holdsSecretRefs(parsed)) return fail("invalid", intentRefsRefused);
  return map(migrate(parsed), ({ value, from }) => ({ json: value, from }));
};

/** What the source is, as an intent not yet checked. */
const candidateOf = (source: BackupSource, saved: ReturnType<typeof savedFile>): Result<{ json: unknown; from?: number }, Problem> => {
  switch (source.from) {
    case "file":
      return fromText(source.text);
    case "defaults": {
      if (!saved.exists) return fail("not-found", "No settings are saved yet: there is nothing to reset.");
      const valid = saved.read.ok ? checkedIntent(saved.read.value) : undefined;
      return valid?.ok
        ? ok({ json: resetIntent(valid.value) })
        : fail("conflict", "The saved settings are not valid, so they cannot be reset: restore a backup instead.");
    }
    // Over nothing, or over a file that does not read (kept, as any replaced file is).
    case "new":
      return saved.read.ok ? fail("conflict", "Settings are already saved here.") : ok({ json: starterIntent(source.choices, newSiteId()) });
  }
};

export type ReviewInput = {
  source: BackupSource;
  files: Files;
  intentPath: string;
  /** The saved file's version the review was of: a restore refuses another. */
  version?: string;
  now: () => number;
};

export type Reviewed = {
  review: BackupReview;
  /** The saved file's version it was made over ("" with none saved). */
  version: string;
  /** What would be written, when the review allows it. */
  write?: Intent;
};

/** A source reviewed against the saved file: what writing it would change, or why it cannot be written. */
export const reviewBackup = ({ source, files, intentPath }: ReviewInput): Result<Reviewed, Problem> => {
  const saved = savedFile(files, intentPath);
  const candidate = candidateOf(source, saved);
  if (!candidate.ok) return candidate;
  const { json, from } = candidate.value;
  // What is saved, when it reads: to name another network and list what changes.
  const before = saved.read.ok ? saved.read.value : undefined;
  const base: BackupReview = {
    ...(from !== undefined && from < intentVersion ? { upgradedFrom: from } : {}),
    ...(before !== undefined && siteOfJson(json) !== siteOfJson(before) ? { otherNetwork: String((json as Intent)?.system?.name ?? "") } : {}),
    issues: [],
    changes: [],
  };
  const checked = checkedIntent(json);
  if (!checked.ok) {
    const issues = checked.error.kind === "invalid" ? (checked.error.details?.issues as BackupReview["issues"]) : undefined;
    return issues ? ok({ review: { ...base, issues }, version: saved.version }) : checked;
  }
  const changes = before === undefined ? [] : diffIntent(before, checked.value);
  return ok({ review: { ...base, changes }, version: saved.version, write: checked.value });
};

/**
 * A source written as the saved settings, once its review allows it and
 * the saved file is still the one reviewed; the file it replaces kept
 * (writeIntentFile).
 */
export const restoreBackup = (input: ReviewInput): Result<BackupReview, Problem> => {
  const reviewed = reviewBackup(input);
  if (!reviewed.ok) return reviewed;
  const { review, version, write } = reviewed.value;
  if (input.version !== undefined && input.version !== version) {
    return fail("conflict", "The settings were changed elsewhere since they were reviewed: check what it changes now.", { details: { changedElsewhere: true } });
  }
  if (write === undefined) return fail("invalid", "Some settings need fixing.", { details: { review } });
  return map(writeIntentFile(input.files, input.intentPath, write, { keepOld: "always", at: input.now() }), () => review);
};
