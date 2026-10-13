// One lock across processes (the Node server, CGI requests, a background
// job): a directory, as mkdir is atomic. Taking over one left by a process
// that died is check-then-act, so it is done holding a second, momentary
// lock: two requests that both find it stale cannot both take it.
import { Platform } from "./platform";
import { shellQuote } from "./shell";

/**
 * Shell that takes `lock`, or takes it over when `stale` (a shell condition)
 * holds; exits non-zero when it is held. A takeover lock older than a minute
 * was left by a process killed mid-takeover.
 */
export const takeLockCommand = (lock: string, stale: string) => {
  const l = shellQuote(lock);
  const t = shellQuote(`${lock}.takeover`);
  return [
    `find ${t} -prune -mmin +1 2>/dev/null | grep -q . && rmdir ${t}`,
    `mkdir ${l} 2>/dev/null || { mkdir ${t} 2>/dev/null && { { ${stale}; } && rm -rf ${l} && mkdir ${l}; r=$?; rmdir ${t}; [ $r -eq 0 ]; }; }`,
  ].join("\n");
};

/** A shell condition: `path` was last changed more than `minutes` ago. */
export const olderThan = (path: string, minutes: number) =>
  `find ${shellQuote(path)} -prune -mmin +${minutes} | grep -q .`;

/**
 * Run `work` holding the lock at `path`; `busy` when another holds it. One
 * older than `staleMinutes` is taken over, so `work` must always take less.
 * It is given back only by its owner (a token inside): a holder that
 * outlived a takeover does not free the lock of the one that took it.
 */
export const withLock = async <T>(
  platform: Pick<Platform, "run" | "mkdirp">,
  path: string,
  staleMinutes: number,
  work: () => Promise<T>
): Promise<T | "busy"> => {
  platform.mkdirp(path.replace(/\/[^/]*$/, ""));
  const owner = `${path}/owner`;
  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const taken = await platform.run([
    "sh",
    "-c",
    `${takeLockCommand(path, olderThan(path, staleMinutes))} && echo ${token} > ${shellQuote(owner)}`,
  ]);
  if (taken.code !== 0) return "busy";
  try {
    return await work();
  } finally {
    await platform
      .run(["sh", "-c", `[ "$(cat ${shellQuote(owner)} 2>/dev/null)" = ${token} ] && rm -rf ${shellQuote(path)}`])
      .catch(() => undefined);
  }
};
