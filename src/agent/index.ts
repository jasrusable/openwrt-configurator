// The device side of an apply, called by verb (script.ts holds the script,
// records.ts what the step verbs read). Each verb is a command, what it reads
// on stdin, and the parse of its answer, made through `call`: one whose
// session fails says so as a Result, never by throwing, so a dead link is a
// value the phases handle.
import { problem, Problem } from "../problem";
import { attempt, messageOf, Result } from "../result";
import { commandTimeoutMs, ExecResult, Session } from "../platform";
import { shellQuote } from "../shell";
import { agentPath } from "./paths";
import { AgentRecord, encodeRecords } from "./records";
import { agentScript } from "./script";

/** How the device recovers if a provision is never confirmed. */
export type RollbackMode = "reload" | "reboot" | "reload-then-reboot";

/**
 * One call of the agent: its command, what it reads on stdin, how its answer
 * reads, and how long it may take (else the session's `commandTimeoutMs`).
 */
export type Verb<T> = { command: string; stdin?: string; parse: (result: ExecResult) => T; timeoutMs?: number };

/** Package downloads and installs on a slow link or a slow flash: the longest steps there are. */
const packagesTimeoutMs = 15 * 60_000;
/** The run_after_reload hooks are the settings' own commands. */
const hooksTimeoutMs = 5 * 60_000;

const verb = (runId: string, name: string, args: string[] = []) =>
  [`sh ${agentPath(runId)} ${name}`, ...args.map(shellQuote)].join(" ");

const says = (word: string) => ({ stdout }: { stdout: string }) => stdout.includes(word);

/**
 * Write the agent and start a fresh run directory, in one round trip: the
 * script travels on stdin (a long exec request is refused by dropbear).
 */
export const install = (runId: string): Verb<boolean> => ({
  command: `umask 077 && cat > ${agentPath(runId)} && chmod 700 ${agentPath(runId)} && ${verb(runId, "begin")}`,
  stdin: agentScript,
  parse: says("ONC_BEGUN"),
});

/**
 * How a step verb went: every step done, or the step it stopped at (in the
 * agent's words: a path, a package, a config, never a value) and what the
 * device said of it.
 */
export type Steps = { done: true } | { done: false; step: string; stderr: string };

const stepsOf = ({ stdout, stderr, code }: ExecResult): Steps => {
  if (code === 0 && /^ONC_OK$/m.test(stdout)) return { done: true };
  const started = [...stdout.matchAll(/^ONC_STEP (.*)$/gm)];
  return { done: false, step: started.length ? started[started.length - 1][1] : "its first step", stderr: stderr.trim() };
};

const steps = (runId: string, name: string, records: AgentRecord[], timeoutMs?: number): Verb<Steps> => ({
  command: verb(runId, name),
  stdin: encodeRecords(records),
  parse: stepsOf,
  ...(timeoutMs ? { timeoutMs } : {}),
});

/** Discard every staged uci change on the device, whoever made it. */
export const revert = (runId: string): Verb<Steps> => ({ command: verb(runId, "revert"), parse: stepsOf });

/** Revert, seed the owned configs the device lacks, remove and install packages, refresh the reload baseline. */
export const prepare = (runId: string, records: AgentRecord[]) => steps(runId, "prepare", records, packagesTimeoutMs);

/** The uci batch (the wipe and the declared config), then the managed files. */
export const stage = (runId: string, records: AgentRecord[]) => steps(runId, "stage", records);

/** Commit each changed config, mark the commit done, reload. Its link may drop. */
export const finalise = (runId: string, records: AgentRecord[]) => steps(runId, "finalise", records);

/** Enable and start, or stop and disable, each declared service. */
export const services = (runId: string, records: AgentRecord[]) => steps(runId, "services", records);

/** The run_after_reload hooks, once the config is live. */
export const hooks = (runId: string, records: AgentRecord[]) => steps(runId, "hooks", records, hooksTimeoutMs);

/** Fetch packages a run removes, so a rollback can reinstall them with the network down. How many were kept. */
export const stagePackages = (runId: string, packages: string[]): Verb<number> => ({
  command: verb(runId, "stage-packages", packages),
  parse: ({ stdout }) => Number(/ONC_STAGED\s+(\d+)/.exec(stdout)?.[1] ?? 0),
  timeoutMs: packagesTimeoutMs,
});

/** What a rollback puts back, beyond /etc/config. */
export type ArmPlan = {
  timeoutSeconds: number;
  mode: RollbackMode;
  /** How long it waits, after restoring, to hear access is back before rebooting. */
  recoverSeconds: number;
  reloadWireless: boolean;
  /** Files this run creates: removed. */
  filesToDelete: string[];
  /** Files this run touches that may exist: put back as they were. */
  filesToRestore: string[];
  /** Packages this run installs: removed again. */
  newPackages: string[];
  /** Services this run enables, starts or stops: put back running or not. */
  services: string[];
  /** Restarted once the restored config is reloaded. */
  restartAfterRestore: string[];
};

/** The plan's lists, as the agent reads them on stdin: a line each, "<list> <item>". */
const armLines = (plan: ArmPlan) =>
  [
    ...plan.filesToDelete.map((path) => `delete ${path}`),
    ...plan.filesToRestore.map((path) => `restore ${path}`),
    ...plan.newPackages.map((name) => `new-package ${name}`),
    ...plan.services.map((name) => `service ${name}`),
    ...plan.restartAfterRestore.map((name) => `restart ${name}`),
  ].join("\n") + "\n";

/** Items the agent cannot be given (it reads a line each): why, or undefined. */
export const unarmable = (plan: ArmPlan) => {
  const broken = [...plan.filesToDelete, ...plan.filesToRestore].find((path) => /[\n\r]/.test(path));
  return broken === undefined ? undefined : `a managed file's path holds a line break (${JSON.stringify(broken)})`;
};

/** Snapshot the device and start its watchdog. Changes no config. Why not, when it did not. */
export const arm = (runId: string, plan: ArmPlan): Verb<{ armed: boolean; why: string }> => ({
  command: verb(runId, "arm", [
    ...["--timeout", String(plan.timeoutSeconds), "--mode", plan.mode, "--recover", String(plan.recoverSeconds)],
    ...(plan.reloadWireless ? ["--wireless"] : []),
  ]),
  stdin: armLines(plan),
  parse: ({ stdout, stderr }) => ({ armed: stdout.includes("ONC_ARMED"), why: stderr.trim() }),
});

/** Whether the commit finished: a dropped link looks the same before, during and after it. */
export const commitFinished = (runId: string): Verb<boolean> => ({
  command: verb(runId, "commit-finished"),
  parse: says("ONC_COMMITTED"),
});

/** Stand the watchdog down, or learn it fired (restoring, or done). */
export const disarm = (runId: string): Verb<"disarmed" | "fired"> => ({
  command: verb(runId, "disarm"),
  parse: ({ stdout }) => (stdout.includes("ONC_DISARMED") ? "disarmed" : "fired"),
});

/** The run is over on the device: what it leaves (the disarm's marker, its directory, the agent), removed. */
export const finish = (runId: string): Verb<boolean> => ({ command: verb(runId, "done"), parse: says("ONC_DONE") });

/** End the watchdog's wait, so it restores now: whether it was woken (or already restoring). */
export const wake = (runId: string): Verb<boolean> => ({ command: verb(runId, "rollback-now"), parse: says("ONC_WOKEN") });

/** Once the old config is restored, tell the watchdog access is back, so it does not reboot. */
export const recovered = (runId: string): Verb<boolean> => ({ command: verb(runId, "recovered"), parse: says("ONC_RECOVERED") });

/** Undo a failed or refused arm: its snapshots, staged packages and watchdog. Whether all of it is gone. */
export const drop = (runId: string): Verb<boolean> => ({ command: verb(runId, "drop"), parse: says("ONC_DROPPED") });

/**
 * A verb over a session that may be gone: the answer, or why there was none
 * ("unreachable": what the device did is then not known). A channel that
 * closed with no exit status (node-ssh resolves a dropped command that way)
 * is no answer either, never a "no".
 */
export const call = <T>(session: Session, { command, stdin, parse, timeoutMs }: Verb<T>): Promise<Result<T, Problem>> =>
  attempt(
    async () => {
      const result = await session.execCommand(command, {
        ...(stdin === undefined ? {} : { stdin }),
        ...(timeoutMs ? { timeoutMs } : {}),
      });
      if (result.timedOut) throw new Error(`no answer within ${Math.round((timeoutMs ?? commandTimeoutMs) / 1000)} s`);
      if (result.code === null) throw new Error("the connection dropped");
      return parse(result);
    },
    (thrown) => problem("unreachable", messageOf(thrown))
  );
