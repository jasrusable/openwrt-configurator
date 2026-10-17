// An apply's bookkeeping beside the intent, whoever runs it: the UI's
// background job (`provision <snapshot> --job <dir> --run-id <id>`, started
// detached by startProvision, as a CGI request lives for one response), the
// CLI (`provision <intent>`, in its own process: beginRun), an undo, and the
// apply after a firmware upgrade. Its state is beside the intent, so a CGI
// process, the Node server, the collector and the CLI see the same run:
//
// - the lock (src/lock.ts), held by the run's id from start to end, so two
//   applies cannot both start, and a Status action and an apply exclude each
//   other (each takes its own lock first, then checks the other's);
// - the run's record, written by whoever starts it: its id, when, its pid;
// - its outcome, written by the run itself as it ends, or is asked to stop
//   (`jobEnding`): a run killed outright (kill -9, out of memory, the host
//   restarting) writes none, and reads as interrupted.
//
// A run is alive while a process with its pid is still it: the job's has its
// id on its command line, the CLI's the very command line it had at its
// start. A pid handed to another process (after it died, or a reboot) never
// passes for it.
//
// A run applies a snapshot of the intent taken as it starts, so edits made
// meanwhile are not half-applied. Only a run that applied promotes that
// snapshot to `live.json`: the UI compares the draft with it. The live one it
// replaces is kept (`live.previous.json`), with when each was applied, so the
// last apply can be undone by applying the previous one again.
//
// A run killed while its devices are armed leaves their watchdogs to restore
// them at their deadlines: its lock is free to take, and the next run's
// planning refuses a device whose watchdog of another run is still alive
// (apply/plan.ts), so no snapshot is restored over a later change.
import { z } from "zod";
import { ApplyProgress, parseEvents, progressOf } from "../applyEvents";
import { appliedExits, appliedWithProblemsExit } from "./outcome";
import { holderOf, LockFiles, lockFresh, releaseLock, takeLock } from "../lock";
import { Platform } from "../platform";
import { canonical } from "../json";
import { Change, diffIntent } from "../intent/diff";
import { intentFileOrNothing } from "../settings";
import { problem, Problem } from "../problem";
import { err, ok, Result } from "../result";
import { keepStatePrivate, read, stateLayout, StoreFiles, StoreKey, tryWrite, write } from "../store";

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
  /** The job's output so far, newest last (none for a run from the command line: its output is its terminal's). */
  log: string;
  /** Where each device is in the run, and how it ended, as the run reported it. */
  progress: ApplyProgress;
  /** Whether the saved draft is what was last provisioned. */
  live: "none" | "matches" | "differs";
  /** When the live settings, and the ones before them, were applied. */
  applied: Applied;
  /** The run's own changes, as they stood when it started; and whether it was an undo. */
  run?: { changes: Change[]; undo: boolean };
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
  /** The live settings an apply replaced: what undoing it applies again. */
  previous: `${dir}/live.previous.json`,
  /** The reviewed plan's state hashes, which the run checks before arming (`provision --verify`). */
  verify: `${dir}/provision.verify.json`,
  applied: `${dir}/provision.applied.json`,
});

export const jobPaths = (intentPath: string) => jobFiles(stateLayout(intentPath).root);

const changeSchema = z.object({
  path: z.string(),
  label: z.array(z.string()),
  kind: z.enum(["added", "removed", "changed"]),
  before: z.string().optional(),
  after: z.string().optional(),
  description: z.string().optional(),
});
const recordSchema = z.object({
  runId: z.string(),
  startedAt: z.number(),
  pid: z.number().int().optional(),
  /** A run in a process it did not start for itself (the CLI): alive while its pid has this command line. */
  commandLine: z.string().optional(),
  /** What this run changes, against what was live as it started. */
  changes: z.array(changeSchema).optional(),
  /** It applies the previous settings again. */
  undo: z.boolean().optional(),
});
const appliedSchema = z.object({ live: z.number().optional(), previous: z.number().optional() });
export type Applied = z.infer<typeof appliedSchema>;
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
const appliedKey = (dir: string): StoreKey<Applied> => ({ path: jobFiles(dir).applied, schema: appliedSchema, format: 1 });

/** When the live settings and the ones before them were applied. */
export const appliedTimes = (files: Pick<Platform, "readTextFile">, intentPath: string): Applied =>
  read(files, appliedKey(jobPaths(intentPath).dir)) ?? {};

/** A run started this recently with no pid yet is still being started. */
const startingMs = 60_000;

/** The argument that names a run on its command line. */
const runIdFlag = "--run-id";

/** Whether the run is going: its process, by pid, still the one it was. */
const runAlive = async (files: Pick<Platform, "commandLineOf">, run: JobRecord, now: () => number) => {
  if (run.pid === undefined) return now() - run.startedAt < startingMs;
  const line = await files.commandLineOf(run.pid);
  return !!line && (run.commandLine !== undefined ? line === run.commandLine : line.includes(`${runIdFlag} ${run.runId}`));
};

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
  // One that said how it ended has, whether or not its process goes on (one
  // that could not be started has no process; the CLI's may outlive its run).
  const said = outcome();
  if (said) return ended(said);
  // Then alive, then the outcome again: a run writes its outcome before it
  // ends, so one seen gone has either said how it ended or was really interrupted.
  if (await runAlive(files, run, now)) return { state: "running", startedAt: run.startedAt };
  return ended(outcome());
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

/**
 * Whether an apply is running: its lock held by a run that is still alive.
 * What everything that must not touch the devices meanwhile asks (the
 * collector, Status actions, the change plan, an undo).
 */
export const applyRunning = async ({
  intentPath,
  files,
  now = Date.now,
}: {
  intentPath: string;
  files: JobFiles;
  now?: () => number;
}): Promise<boolean> => {
  const paths = jobPaths(intentPath);
  const since = files.modifiedAt(paths.lock);
  return since !== undefined && !(await holderGone(files, paths.dir, holderOf(files, paths.lock), since, now));
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
  const record = job.state === "idle" ? undefined : read(files, jobRecordKey(jobPaths(intentPath).dir));
  return {
    ...job,
    log: (readText(files, jobPaths(intentPath).log) ?? "").split("\n").slice(-400).join("\n"),
    progress: job.state === "idle" ? { devices: {} } : jobProgress(intentPath, files),
    live: liveState(intentPath, files),
    applied: appliedTimes(files, intentPath),
    ...(record ? { run: { changes: record.changes ?? [], undo: record.undo ?? false } } : {}),
  };
};

const busy = "Settings are already being applied.";

type ClaimOptions = {
  intentPath: string;
  files: JobFiles & Pick<Platform, "sha256">;
  now: () => number;
  /** What to apply: the saved intent, or (undoing) the previous live settings. */
  source?: string;
  undo?: boolean;
  /** Per device, the state hash its reviewed plan was read from (src/applyPlan.ts); none, as from the CLI: not checked. */
  verify?: Record<string, string>;
  /** The saved intent's version (its sha256) the reviewed plan was compiled from: refused if the file is another now. */
  version?: string;
  /** Done holding the lock, before the snapshot is taken (an undo making the previous settings the saved ones). */
  prepare?: () => Result<void, Problem>;
};

/**
 * Take the lock and lay the run's files down: a fresh run's (nothing of the
 * last one's progress, outcome or output), the snapshot it applies, its
 * record. Refused, the lock given back, while a Status action runs (it took
 * its lock first, then found no apply), or when the settings are no longer
 * the version reviewed.
 */
const claim = async ({ intentPath, files, now, source = intentPath, undo = false, verify, version, prepare }: ClaimOptions) => {
  const paths = jobPaths(intentPath);
  // Owner-only: it holds snapshots of the intent.
  keepStatePrivate(files, intentPath);
  const runId = `${now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  if (!(await takeLock(files, paths.lock, runId, (holder, since) => holderGone(files, paths.dir, holder, since, now), now))) {
    return err(problem("conflict", busy));
  }
  const refused = (why: Problem) => (releaseLock(files, paths.lock, runId), err(why));
  if (lockFresh(files, stateLayout(intentPath).actionLock, now)) {
    return refused(problem("busy", "A Status action is running: apply when it has finished."));
  }
  if (version !== undefined && files.sha256(readText(files, intentPath) ?? "") !== version) {
    return refused(problem("conflict", "The settings were changed since these changes were reviewed: review them again."));
  }
  const prepared = prepare?.() ?? ok(undefined);
  if (!prepared.ok) return refused(prepared.error);
  [paths.events, paths.outcome, paths.log, paths.verify].forEach((path) => files.removeFile(path));
  if (verify) files.writeFileAtomic(paths.verify, JSON.stringify(verify), 0o600);
  files.writeFileAtomic(paths.snapshot, files.readTextFile(source), 0o600);
  const startedAt = now();
  // What it changes, in the user's terms, kept for the summary once it ends.
  const live = intentFileOrNothing(files, paths.live);
  const changes = live ? diffIntent(live, intentFileOrNothing(files, paths.snapshot)) : [];
  const record: JobRecord = { runId, startedAt, changes, undo };
  write(files, jobRecordKey(paths.dir), record);
  return ok({ runId, record, paths });
};

/**
 * Start a provision of the saved intent (or, undoing, of `source`: the
 * previous live settings) as a background job, unless one is already running.
 */
export const startProvision = async ({
  upgrade,
  acceptNewSeries,
  acceptDowngrade,
  ...options
}: ClaimOptions & {
  files: Pick<Platform, "selfCommand" | "spawnDetached">;
  /** Upgrade these devices' firmware first (src/firmware/run.ts), or every one behind ("all"). */
  upgrade?: string[] | "all";
  /** The upgrade may move into a series this app has not been checked against: acknowledged. */
  acceptNewSeries?: boolean;
  /** The upgrade may move a device back: acknowledged. */
  acceptDowngrade?: boolean;
}) => {
  const { files, now } = options;
  const claimed = await claim(options);
  if (!claimed.ok) return { started: false as const, reason: claimed.error.message, problem: claimed.error };
  const { runId, record, paths } = claimed.value;
  // It refreshes the device facts as it reads the devices (deviceFacts.ts).
  const argv = [
    ...files.selfCommand(),
    ...["provision", paths.snapshot, "--facts-for", options.intentPath, "--events", paths.events, "--job", paths.dir, runIdFlag, runId],
    ...(options.verify ? ["--verify", paths.verify] : []),
    ...(upgrade ? ["--upgrade", upgrade === "all" ? "all" : upgrade.join(",")] : []),
    ...(upgrade && acceptNewSeries ? ["--accept-new-series"] : []),
    ...(upgrade && acceptDowngrade ? ["--accept-downgrade"] : []),
  ];
  let pid: number;
  try {
    pid = files.spawnDetached(argv, { log: paths.log });
  } catch (e) {
    tryWrite(files, outcomeKey(paths.dir), { runId, at: now(), exitCode: 127 });
    releaseLock(files, paths.lock, runId);
    const reason = `Could not start the provision: ${(e as Error)?.message ?? e}`;
    return { started: false as const, reason, problem: problem("failed", reason) };
  }
  // Started whatever this says: a record that could not take its pid (a full
  // disk) only makes the run look interrupted a minute on.
  tryWrite(files, jobRecordKey(paths.dir), { ...record, pid });
  return { started: true as const, runId };
};

/**
 * This process's pid and command line: the parent of a shell it starts. What
 * tells a run from the command line apart from any process after it.
 */
const ownProcess = async (files: Pick<Platform, "run" | "commandLineOf">) => {
  const pid = Number((await files.run(["sh", "-c", 'echo "$PPID"'])).stdout.trim());
  const commandLine = Number.isInteger(pid) && pid > 1 ? await files.commandLineOf(pid) : undefined;
  if (!commandLine) throw new Error("Could not tell this process apart from others, to hold the apply's lock.");
  return { pid, commandLine };
};

/**
 * A run in this process (`provision <intent>` from the command line), kept
 * as the UI's job is: the lock, a record, the snapshot it applies, its
 * events; it ends by `jobEnding`, as a job does.
 */
export const beginRun = async (options: Omit<ClaimOptions, "source" | "undo" | "prepare"> & { files: Pick<Platform, "run"> }) => {
  const own = await ownProcess(options.files);
  const claimed = await claim(options);
  if (!claimed.ok) return claimed;
  const { runId, record, paths } = claimed.value;
  write(options.files, jobRecordKey(paths.dir), { ...record, ...own });
  return ok({ runId, paths });
};

/**
 * How a run ends (`provision --job`, or one from the command line), once: its
 * outcome kept, the snapshot it applied made live, the lock given back. What
 * it is given is its exit status, or the signal that stopped it.
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
        // What was live becomes the one an undo puts back.
        const was = readText(files, paths.live);
        if (was !== undefined) files.writeFileAtomic(paths.previous, was, 0o600);
        files.writeFileAtomic(paths.live, files.readTextFile(paths.snapshot), 0o600);
        files.removeFile(paths.snapshot);
        const times = read(files, appliedKey(dir)) ?? {};
        tryWrite(files, appliedKey(dir), { live: now(), ...(was !== undefined && times.live !== undefined ? { previous: times.live } : {}) });
      } catch {
        // Applied, but not recorded as live: the UI then offers to apply again.
      }
    }
    releaseLock(files, paths.lock, runId);
  };
};
