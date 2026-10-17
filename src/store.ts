// What this app keeps beside an intent (`<intent>.state/`) and in the status
// collector's directory: small JSON values, each declared once as a key
// (where it lives, its shape, its format) and read and written only through
// here. A value is kept as `{ "format": N, "value": ... }`, written whole and
// atomically, owner-only unless its key says otherwise. Reading never throws:
// a file that is missing, not JSON, of another shape or of an older format
// reads as nothing, unless the key knows how to bring an older one up to date
// (`upgrade`), which is also how files from before the store are read.
import { z } from "zod";
import { parseJson } from "./parseJson";
import { dirname } from "./posixPath";
import { Platform } from "./platform";
import { err, messageOf, ok, Result } from "./result";
import { problem, Problem } from "./problem";

export type StoreFiles = Pick<Platform, "readTextFile" | "writeFileAtomic" | "mkdirp" | "removeFile">;

/** What the store makes is its owner's alone: the files are, and so are the directories that name them. */
const privateDir = 0o700;

export type StoreKey<T> = {
  path: string;
  schema: z.ZodType<T>;
  /** Raised when the shape changes, so a value kept in the old one is not taken for the new. */
  format: number;
  /** File permissions; owner-only unless said. */
  mode?: number;
  /**
   * A value kept in another format (`format` undefined: a file from before
   * the store, as written), as this one: what the schema then checks.
   * Without it, such a file reads as nothing.
   */
  upgrade?: (stored: unknown, format: number | undefined) => unknown;
};

/** `{ format, value }`, as the store writes; anything else is a file from before it. */
const envelopeOf = (stored: unknown) =>
  stored && typeof stored === "object" && !Array.isArray(stored) && "value" in stored && typeof (stored as { format?: unknown }).format === "number"
    ? (stored as { format: number; value: unknown })
    : undefined;

/** The value kept, or undefined when there is none fit to use. */
export const read = <T>(files: Pick<Platform, "readTextFile">, key: StoreKey<T>): T | undefined => {
  let stored: unknown;
  try {
    stored = parseJson(files.readTextFile(key.path), key.path);
  } catch {
    return undefined;
  }
  const kept = envelopeOf(stored);
  const [format, value] = kept ? [kept.format, kept.value] : [undefined, stored];
  const current = format === key.format ? value : key.upgrade?.(value, format);
  const parsed = key.schema.safeParse(current);
  return parsed.success ? parsed.data : undefined;
};

/** Keep `value`, whole: written aside and renamed into place, with its mode from the start. */
export const write = <T>(files: StoreFiles, key: StoreKey<T>, value: T) => {
  files.mkdirp(dirname(key.path), privateDir);
  files.writeFileAtomic(key.path, JSON.stringify({ format: key.format, value }), key.mode ?? 0o600);
};

/** Keep `value`, or say why it could not be (a full disk, say), for a caller that carries on either way. */
export const tryWrite = <T>(files: StoreFiles, key: StoreKey<T>, value: T): Result<void, Problem> => {
  try {
    write(files, key, value);
    return ok(undefined);
  } catch (thrown) {
    return err(problem("internal", messageOf(thrown)));
  }
};

/**
 * Keep what `change` makes of the value kept (undefined when there is none).
 * Not locked: two processes updating one key at once (a status read and an
 * apply, say) can lose one update, never corrupt the file (each write is
 * whole, through its own temporary file). Every value kept this way is what
 * a device said, read again on its next read, so a lost update heals itself;
 * a value that must not be lost needs a lock (src/lock.ts) around it.
 */
export const update = <T>(files: StoreFiles, key: StoreKey<T>, change: (current: T | undefined) => T) => {
  const next = change(read(files, key));
  write(files, key, next);
  return next;
};

/** A value moved to another key as it is, whatever its format: renaming what it belongs to. */
export const move = (files: StoreFiles, from: StoreKey<unknown>, to: StoreKey<unknown>) => {
  const text = files.readTextFile(from.path);
  files.mkdirp(dirname(to.path), privateDir);
  files.writeFileAtomic(to.path, text, to.mode ?? 0o600);
  files.removeFile(from.path);
};

export const remove = (files: Pick<Platform, "removeFile">, key: StoreKey<unknown>) => files.removeFile(key.path);

/**
 * Every value kept in a directory of one key per item (devices' facts, say):
 * each file's key from its name, and only those that read.
 */
export const list = <T>(
  files: Pick<Platform, "readTextFile" | "listDir">,
  dir: string,
  keyOf: (name: string) => StoreKey<T> | undefined
): T[] =>
  files.listDir(dir).flatMap((name) => {
    const key = keyOf(name);
    const value = key && read(files, key);
    return value === undefined ? [] : [value];
  });

/** A file name for an item named by anyone (a hostname, an address): one plain name, never a path or a dot file. */
export const fileName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");

/**
 * The state directory, made or tightened owner-only (one made before this
 * was 0755: its files' names say which devices there are, and their runs).
 */
export const keepStatePrivate = (files: Pick<Platform, "mkdirp">, intentPath: string) =>
  files.mkdirp(stateLayout(intentPath).root, privateDir);

/**
 * Where everything kept beside an intent lives (`<intent>.state/`): the one
 * place a path under it is spelt out.
 */
export const stateLayout = (intentPath: string) => {
  const root = `${intentPath}.state`;
  return {
    root,
    /** Each device's facts, one file per device (src/deviceFacts.ts). */
    devices: `${root}/devices`,
    /** The lock one read of facts at a time takes (src/readEach.ts). */
    readingLock: `${root}/devices/.reading`,
    /** Each device's last failed read (src/deviceFacts.ts). */
    attempts: `${root}/attempts`,
    /** What a device found in Hardware › Add said (src/discover.ts). */
    inspected: `${root}/inspected`,
    /** The status collector's snapshot and history (a Mac's; a router's are in RAM). */
    status: `${root}/status`,
    /** Wrong passwords, one marker file each (a Mac's; a router counts them in RAM). */
    loginAttempts: `${root}/login-attempts`,
    /** The router's speed tests, the latest first (src/status/actions.ts). */
    speedTests: `${root}/speed-tests.json`,
    /** OpenWrt's releases by series, as ASU last listed them (src/firmware/releases.ts). */
    releases: `${root}/openwrt-releases.json`,
    /** Firmware images built for an upgrade, by what went into them (src/firmware/builds.ts). */
    images: `${root}/images`,
    /** Devices asked to reboot, and when (src/status/actions.ts). */
    rebooting: `${root}/rebooting.json`,
    /** The settings last applied, as written then (src/server/provisionJob.ts keeps it). */
    lastApplied: `${root}/live.json`,
    /** What each device was left holding by the last apply, as hashes (src/applyChanges.ts). */
    applied: `${root}/applied`,
    /** The lock a Status action takes, one action at a time. */
    actionLock: (name: string) => `${root}/${name}.lock`,
  };
};

