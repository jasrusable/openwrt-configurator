// One lock across processes (the Node server, CGI requests, a background
// job): a directory, as making one is atomic, holding its owner's token.
// Taking over one whose holder is gone is check-then-act, so it is done
// holding a second, momentary lock: two requests that both find it stale
// cannot both take it.
import { dirname } from "./posixPath";
import { Platform } from "./platform";

export type LockFiles = Pick<Platform, "makeDir" | "removeDir" | "mkdirp" | "modifiedAt" | "readTextFile" | "writeTextFile">;

/** A takeover lock older than this was left by a process killed mid-takeover. */
const takeoverStaleMs = 60_000;

const ownerFile = (lock: string) => `${lock}/owner`;

/** Who holds `lock`: its owner's token, or undefined when it is not held or not yet written. */
export const holderOf = (files: Pick<Platform, "readTextFile">, lock: string) => {
  try {
    return files.readTextFile(ownerFile(lock)).trim() || undefined;
  } catch {
    return undefined;
  }
};

/**
 * Take `lock` as `owner`; or, when it is held, take it over if `stale` says
 * its holder is gone (given the holder's token and when the lock was last
 * changed). False when it is held.
 */
export const takeLock = async (
  files: LockFiles,
  lock: string,
  owner: string,
  stale: (holder: string | undefined, since: number | undefined) => boolean | Promise<boolean>,
  now: () => number = Date.now
): Promise<boolean> => {
  files.mkdirp(dirname(lock));
  const own = () => (files.writeTextFile(ownerFile(lock), owner), true);
  if (files.makeDir(lock)) return own();
  const takeover = `${lock}.takeover`;
  const since = files.modifiedAt(takeover);
  if (since !== undefined && now() - since > takeoverStaleMs) files.removeDir(takeover);
  if (!files.makeDir(takeover)) return false;
  try {
    if (!(await stale(holderOf(files, lock), files.modifiedAt(lock)))) return false;
    files.removeDir(lock);
    return files.makeDir(lock) && own();
  } finally {
    files.removeDir(takeover);
  }
};

/** Give `lock` back, only if `owner` still holds it: one that outlived a takeover frees nothing. */
export const releaseLock = (files: Pick<Platform, "readTextFile" | "removeDir">, lock: string, owner: string) => {
  if (holderOf(files, lock) === owner) files.removeDir(lock);
};

/** Whether a `withLock` lock is held now: there, and not so old it would be taken over. */
export const lockFresh = (files: Pick<Platform, "modifiedAt">, path: string, now: () => number = Date.now, staleMinutes = 1) => {
  const since = files.modifiedAt(path);
  return since !== undefined && now() - since <= staleMinutes * 60_000;
};

/**
 * Run `work` holding the lock at `path`; `busy` when another holds it. One
 * not changed for `staleMinutes` is taken over, so `work` must always take less.
 */
export const withLock = async <T>(
  files: LockFiles,
  path: string,
  staleMinutes: number,
  work: () => Promise<T>,
  now: () => number = Date.now
): Promise<T | "busy"> => {
  const token = `${now()}-${Math.random().toString(36).slice(2)}`;
  const old = (_: string | undefined, since: number | undefined) => since === undefined || now() - since > staleMinutes * 60_000;
  if (!(await takeLock(files, path, token, old, now))) return "busy";
  try {
    return await work();
  } finally {
    releaseLock(files, path, token);
  }
};
