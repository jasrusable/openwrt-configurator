// This app's own updates, where it runs on a router (docs/design/release-plan.md,
// "Updating the app"). apk knows: `apk policy` lists the version installed
// and those its feeds offer (from the index it last fetched, so no network),
// and `apk version -t` orders them as apk does (a dev build's `_p` suffix
// included). The index is fetched again at most once a day (the collector's
// hourly work) or when asked. An update installs the newer package detached,
// as it replaces the program answering, restarts the collector, and leaves
// its exit status for the page, which reloads into the new version. Nothing
// here changes a device: what a new version writes differently waits for an
// apply ("App update" lines).
import { z } from "zod";
import { Platform } from "./platform";
import { selfPackage } from "./firmware/upgradeScript";
import { read, stateLayout, StoreKey, tryWrite } from "./store";
import { shellQuote } from "./shell";

/** How long a fetched index stands before the next check fetches it again. */
export const appIndexFreshMs = 24 * 3600 * 1000;
/** Past this, a run that never wrote its status is taken as ended. */
const runLimitMs = 10 * 60_000;

export type AppRun = { at: number; from: string; to: string; pid: number; done?: { ok: boolean; at: number } };

export type AppUpdate = {
  installed: string;
  /** The newest version a feed offers, when newer than the one installed. */
  available?: string;
  /** When the feeds' index was last fetched. */
  checkedAt?: number;
  /** The last update started from here, and how it ended. */
  run?: AppRun & { running: boolean };
};

const paths = (intentPath: string) => {
  const root = stateLayout(intentPath).root;
  return { checked: `${root}/app-checked.json`, run: `${root}/app-update.json`, exit: `${root}/app-update.exit`, log: `${root}/app-update.log` };
};

const checkedKey = (intentPath: string): StoreKey<{ at: number }> => ({ path: paths(intentPath).checked, schema: z.object({ at: z.number() }), format: 1 });
const runKey = (intentPath: string): StoreKey<AppRun> => ({
  path: paths(intentPath).run,
  schema: z.object({ at: z.number(), from: z.string(), to: z.string(), pid: z.number(), done: z.object({ ok: z.boolean(), at: z.number() }).optional() }),
  format: 1,
});

/** `apk policy <package>`'s versions, each with whether it is the one installed. */
export const parsePolicy = (text: string) =>
  text
    .split("\n")
    .reduce<{ version: string; installed: boolean }[]>((versions, line) => {
      const version = /^ {2}(\S+):$/.exec(line)?.[1];
      if (version) return [...versions, { version, installed: false }];
      const last = versions[versions.length - 1];
      return last && /^ {4}\S*lib\/apk\/db\/installed$/.test(line) ? [...versions.slice(0, -1), { ...last, installed: true }] : versions;
    }, []);

type Run = Pick<Platform, "run">;

const runs = async (platform: Run, argv: string[], timeoutMs = 10_000) => {
  try {
    return await platform.run(argv, { timeoutMs });
  } catch {
    // No apk here (a Mac): not a router.
    return undefined;
  }
};

/** Whether apk orders `a` after `b`. */
const newer = async (platform: Run, a: string, b: string) => (await runs(platform, ["apk", "version", "-t", a, b]))?.stdout.trim() === ">";

/** The version installed and the newest one offered, if newer; undefined where apk does not know this app (not a router). */
export const appVersions = async (platform: Run): Promise<{ installed: string; available?: string } | undefined> => {
  const policy = await runs(platform, ["apk", "policy", selfPackage]);
  if (!policy || policy.code !== 0) return undefined;
  const versions = parsePolicy(policy.stdout);
  const installed = versions.find((v) => v.installed)?.version;
  if (!installed) return undefined;
  const offered = versions.filter((v) => !v.installed).map((v) => v.version);
  const available = await offered.reduce<Promise<string | undefined>>(
    async (best, version) => {
      const current = await best;
      return (await newer(platform, version, current ?? installed)) ? version : current;
    },
    Promise.resolve(undefined)
  );
  return { installed, ...(available ? { available } : {}) };
};

/** Fetches the feeds' index when the last fetch is older than `maxAgeMs` (0: now). Only where apk knows this app. */
export const refreshAppIndex = async ({
  intentPath,
  platform,
  now = Date.now,
  maxAgeMs = appIndexFreshMs,
}: {
  intentPath: string;
  platform: Pick<Platform, "run" | "readTextFile" | "writeFileAtomic" | "mkdirp" | "removeFile">;
  now?: () => number;
  maxAgeMs?: number;
}) => {
  const last = read(platform, checkedKey(intentPath))?.at;
  if (last !== undefined && now() - last < maxAgeMs) return;
  if (!(await appVersions(platform))) return;
  const fetched = await runs(platform, ["apk", "update"], 60_000);
  if (fetched?.code === 0) tryWrite(platform, checkedKey(intentPath), { at: now() });
};

/** The last run, with how it ended once its status is written (or it is long gone). */
const lastRun = (files: Pick<Platform, "readTextFile">, intentPath: string, now: number): AppUpdate["run"] => {
  const run = read(files, runKey(intentPath));
  if (!run) return undefined;
  const exit = (() => {
    try {
      return files.readTextFile(paths(intentPath).exit).trim();
    } catch {
      return undefined;
    }
  })();
  if (exit !== undefined) return { ...run, running: false, done: { ok: exit === "0", at: run.done?.at ?? now } };
  return { ...run, running: now - run.at < runLimitMs, ...(now - run.at >= runLimitMs ? { done: { ok: false, at: run.at + runLimitMs } } : {}) };
};

/** Where this app stands, for the page; undefined where it is not on a router. */
export const appUpdate = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Pick<Platform, "run" | "readTextFile">;
  now?: () => number;
}): Promise<AppUpdate | undefined> => {
  const versions = await appVersions(platform);
  if (!versions) return undefined;
  const checkedAt = read(platform, checkedKey(intentPath))?.at;
  const run = lastRun(platform, intentPath, now());
  return { ...versions, ...(checkedAt !== undefined ? { checkedAt } : {}), ...(run ? { run } : {}) };
};

/** The detached update: the newest package, the collector restarted on it, then the exit status for the page. */
export const updateScript = (intentPath: string) => {
  const { exit } = paths(intentPath);
  return [
    `apk update && apk add --upgrade ${shellQuote(selfPackage)}`,
    "rc=$?",
    "/etc/init.d/onc-collector restart",
    `printf '%s' "$rc" > ${shellQuote(exit)}`,
  ].join("\n");
};

/** Starts the update, or says why not: not a router, nothing newer, one running already. */
export const startAppUpdate = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Pick<Platform, "run" | "readTextFile" | "writeFileAtomic" | "mkdirp" | "removeFile" | "spawnDetached">;
  now?: () => number;
}): Promise<{ started: AppRun } | { refused: string }> => {
  const state = await appUpdate({ intentPath, platform, now });
  if (!state) return { refused: "This app updates itself only where it runs on a router." };
  if (state.run?.running) return { refused: "An update is already running." };
  if (!state.available) return { refused: "This is the newest version." };
  const { exit, log } = paths(intentPath);
  try {
    platform.removeFile(exit);
  } catch {
    // None yet.
  }
  const pid = platform.spawnDetached(["sh", "-c", updateScript(intentPath)], { log });
  const started = { at: now(), from: state.installed, to: state.available, pid };
  const written = tryWrite(platform, runKey(intentPath), started);
  return written.ok ? { started } : { refused: written.error.message };
};
