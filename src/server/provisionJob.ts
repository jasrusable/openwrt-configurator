// Provisioning started from the UI, as a background job. A provision takes
// minutes and a CGI request lives for one response, so the job is this
// program run again (`provision <snapshot> --job <dir> --run-id <id>`),
// detached, in a session of its own, with its output in a log the UI polls.
// Its state is beside the intent, so a CGI process and the Node server see
// the same job:
//
// - the lock (src/lock.ts), held by the run's id from start to end, so two
//   requests cannot both start one;
// - the run's record, written by whoever starts it: its id, when, its pid;
// - its outcome, written by the run itself as it ends, or is asked to stop
//   (`jobEnding`): a run killed outright (kill -9, out of memory, the host
//   restarting) writes none, and reads as interrupted.
//
// A run is alive while a process with its pid has its id on its command
// line: a pid handed to another process (after it died, or a reboot) never
// passes for it.
//
// The job provisions a snapshot of the intent taken when it starts, so edits
// made meanwhile are not half-applied. Only a run that applied promotes that
// snapshot to `live.json`: the UI compares the draft with it.
import { z } from "zod";
import { ApplyProgress, parseEvents, progressOf } from "../applyEvents";
import { appliedExits, appliedWithProblemsExit } from "../apply/outcome";
import { holderOf, LockFiles, releaseLock, takeLock } from "../lock";
import { Platform } from "../platform";
import { canonical } from "../json";
import { read, stateLayout, StoreFiles, StoreKey, tryWrite, write } from "../store";

type JobFiles = StoreFiles & LockFiles & Pick<Platform, "commandLineOf">;

export type ProvisionState =
  | "idle"
  | "running"
  | "succeeded"
  | "failed"
  /** Applied everywhere, but a step after it (a hook) failed. */
  | "applied-with-problems"
  /** The run ended without saying how: stopped, killed, or the host restarted. */
  | "interrupted";

export type ProvisionStatus = {
  state: ProvisionState;
  startedAt?: number;
  exitCode?: number;
  /** The job's output so far, newest last. */
  log: string;
  /** Where each device is in the run, and how it ended, as the run reported it. */
  progress: ApplyProgress;
  /** Whether the saved draft is what was last provisioned. */
  live: "none" | "matches" | "differs";
};

/** A job's files, in its directory (beside the intent: `<intent>.state`). */
export const jobFiles = (dir: string) => ({
  dir,
  snapshot: `${dir}/provisioning.json`,
  live: `${dir}/live.json`,
  log: `${dir}/provision.log`,
  /** Held by the run's id from start to end. */
  lock: `${dir}/provision.lock`,
  /** Where each device is and how the run ended, as JSON lines (applyEvents.ts). */
  events: `${dir}/provision.events`,
  record: `${dir}/provision.json`,
  outcome: `${dir}/provision.outcome.json`,
});

export const jobPaths = (intentPath: string) => jobFiles(stateLayout(intentPath).root);

const recordSchema = z.object({ runId: z.string(), startedAt: z.number(), pid: z.number().int().optional() });
const outcomeSchema = z.object({
  runId: z.string(),
  at: z.number(),
  /** How the run exited (src/apply/outcome.ts); absent when it was stopped. */
  exitCode: z.number().int().optional(),
  /** The signal that stopped it. */
  signal: z.string().optional(),
});
type JobRecord = z.infer<typeof recordSchema>;
type JobOutcome = z.infer<typeof outcomeSchema>;

export const jobRecordKey = (dir: string): StoreKey<JobRecord> => ({ path: jobFiles(dir).record, schema: recordSchema, format: 1 });
const outcomeKey = (dir: string): StoreKey<JobOutcome> => ({ path: jobFiles(dir).outcome, schema: outcomeSchema, format: 1 });

/** A run started this recently with no pid yet is still being started. */
const startingMs = 60_000;

/** The argument that names a run on its command line. */
const runIdFlag = "--run-id";

/** Whether the run is going: its process, by pid, still the one with its id. */
const runAlive = async (files: Pick<Platform, "commandLineOf">, run: JobRecord, now: () => number) =>
  run.pid === undefined
    ? now() - run.startedAt < startingMs
    : !!(await files.commandLineOf(run.pid))?.includes(`${runIdFlag} ${run.runId}`);

const stateOf = (outcome: JobOutcome | undefined): ProvisionState =>
  !outcome || outcome.exitCode === undefined
    ? "interrupted"
    : outcome.exitCode === 0
    ? "succeeded"
    : outcome.exitCode === appliedWithProblemsExit
    ? "applied-with-problems"
    : "failed";

/** Where the job is, from its record and outcome alone: what a status poll needs, without the log. */
export const jobState = async ({
  intentPath,
  files,
  now = Date.now,
}: {
  intentPath: string;
  files: Pick<Platform, "readTextFile" | "commandLineOf">;
  now?: () => number;
}): Promise<Pick<ProvisionStatus, "state" | "startedAt" | "exitCode">> => {
  const dir = jobPaths(intentPath).dir;
  const run = read(files, jobRecordKey(dir));
  if (!run) return { state: "idle" };
  const outcome = () => {
    const kept = read(files, outcomeKey(dir));
    return kept?.runId === run.runId ? kept : undefined;
  };
  const ended = (own: JobOutcome | undefined) => ({
    state: stateOf(own),
    startedAt: run.startedAt,
    ...(own?.exitCode !== undefined ? { exitCode: own.exitCode } : {}),
  });
  // One that never got a process (it could not be started) has only its outcome.
  const unstarted = run.pid === undefined ? outcome() : undefined;
  if (unstarted) return ended(unstarted);
  // Alive first, then the outcome: a run writes its outcome before it ends,
  // so one seen gone has either said how it ended or was really interrupted.
  if (await runAlive(files, run, now)) return { state: "running", startedAt: run.startedAt };
  return ended(outcome());
};

const readText = (files: Pick<Platform, "readTextFile">, path: string) => {
  try {
    return files.readTextFile(path);
  } catch {
    return undefined;
  }
};

/** Where each device is in the last run, and how it ended, as the run reported it. */
export const jobProgress = (intentPath: string, files: Pick<Platform, "readTextFile">): ApplyProgress =>
  progressOf(parseEvents(readText(files, jobPaths(intentPath).events) ?? ""));

/** A file's JSON, key order aside (the file is rewritten on every save); undefined if it does not parse. */
const canonicalFile = (text: string | undefined) => {
  if (text === undefined) return undefined;
  try {
    return canonical(JSON.parse(text));
  } catch {
    return undefined;
  }
};

/** Whether the saved intent is what was last applied. */
export const liveState = (intentPath: string, files: Pick<Platform, "readTextFile">): ProvisionStatus["live"] => {
  const live = canonicalFile(readText(files, jobPaths(intentPath).live));
  return !live ? "none" : live === canonicalFile(readText(files, intentPath)) ? "matches" : "differs";
};

export const provisionStatus = async ({
  intentPath,
  files,
  now = Date.now,
}: {
  intentPath: string;
  files: Pick<Platform, "readTextFile" | "commandLineOf">;
  now?: () => number;
}): Promise<ProvisionStatus> => {
  const job = await jobState({ intentPath, files, now });
  return {
    ...job,
    log: (readText(files, jobPaths(intentPath).log) ?? "").split("\n").slice(-400).join("\n"),
    progress: job.state === "idle" ? { devices: {} } : jobProgress(intentPath, files),
    live: liveState(intentPath, files),
  };
};

/**
 * Whether the run holding the lock is gone, so its lock may be taken over:
 * no holder written (taken, then killed before it was) once the lock is a
 * minute old; a holder whose record is not yet written likewise; else its
 * run no longer alive.
 */
const holderGone = async (files: JobFiles, dir: string, holder: string | undefined, since: number | undefined, now: () => number) => {
  const run = read(files, jobRecordKey(dir));
  if (!holder || run?.runId !== holder) return since === undefined || now() - since > startingMs;
  return !(await runAlive(files, run, now));
};

const busy = { started: false as const, reason: "Settings are already being applied." };

/** Start a provision of the saved intent, unless one is already running. */
export const startProvision = async ({
  intentPath,
  files,
  now,
}: {
  intentPath: string;
  files: JobFiles & Pick<Platform, "selfCommand" | "spawnDetached">;
  now: () => number;
}) => {
  const paths = jobPaths(intentPath);
  // Owner-only when made here: it holds snapshots of the intent.
  files.makeDir(paths.dir);
  const runId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  if (!(await takeLock(files, paths.lock, runId, (holder, since) => holderGone(files, paths.dir, holder, since, now), now))) {
    return busy;
  }
  // A fresh run: nothing of the last one's progress, outcome or output.
  [paths.events, paths.outcome, paths.log].forEach((path) => files.removeFile(path));
  files.writeFileAtomic(paths.snapshot, files.readTextFile(intentPath), 0o600);
  const startedAt = now();
  write(files, jobRecordKey(paths.dir), { runId, startedAt });
  // It refreshes the device facts as it reads the devices (deviceFacts.ts).
  const argv = [
    ...files.selfCommand(),
    ...["provision", paths.snapshot, "--facts-for", intentPath, "--events", paths.events, "--job", paths.dir, runIdFlag, runId],
  ];
  let pid: number;
  try {
    pid = files.spawnDetached(argv, { log: paths.log });
  } catch (e) {
    tryWrite(files, outcomeKey(paths.dir), { runId, at: now(), exitCode: 127 });
    releaseLock(files, paths.lock, runId);
    return { started: false as const, reason: `Could not start the provision: ${(e as Error)?.message ?? e}` };
  }
  // Started whatever this says: a record that could not take its pid (a full
  // disk) only makes the run look interrupted a minute on.
  tryWrite(files, jobRecordKey(paths.dir), { runId, startedAt, pid });
  return { started: true as const, runId };
};

/**
 * How the run itself ends (`provision --job`), once: its outcome kept, the
 * snapshot it applied made live, the lock given back. What it is given is
 * its exit status, or the signal that stopped it.
 */
export const jobEnding = (files: JobFiles, dir: string, runId: string, now: () => number = Date.now) => {
  let ended = false;
  return (end: { exitCode: number } | { signal: string }) => {
    if (ended) return;
    ended = true;
    const paths = jobFiles(dir);
    tryWrite(files, outcomeKey(dir), { runId, at: now(), ...end });
    if ("exitCode" in end && appliedExits.includes(end.exitCode) && holderOf(files, paths.lock) === runId) {
      try {
        files.writeFileAtomic(paths.live, files.readTextFile(paths.snapshot), 0o600);
        files.removeFile(paths.snapshot);
      } catch {
        // Applied, but not recorded as live: the UI then offers to apply again.
      }
    }
    releaseLock(files, paths.lock, runId);
  };
};
