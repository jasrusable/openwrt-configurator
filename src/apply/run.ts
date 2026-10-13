// One device's provision, as a record the phases pass along:
//
//   plan → stage → arm → configure → commit → confirm → disarm → hooks
//
// (each a module beside this one), plus the ways out: revert (nothing
// committed), roll back now (a committed change must go because something
// else failed) and recover (tell a rolled-back device it need not reboot).
// A phase returns its updated record, or a PhaseFailure (a Problem saying
// what it left on the device) as a Result: provisionNetwork runs them across
// every device and decides from those what to undo. Throwing is for bugs.
import { DeviceStep, Reporter } from "../applyEvents";
import { RollbackMode } from "../agent";
import { AgentRecord } from "../agent/records";
import { ConfirmTiming } from "./reconnect";
import { OpenWrtState } from "../engine/openWrtState";
import { Session } from "../platform";
import { problem, Problem, ProblemKind } from "../problem";
import { attempt, messageOf, Result } from "../result";

export type DeviceRunOptions = {
  /** Checked against board.json when the config declares one. */
  deviceModelId?: string;
  ipAddress: string;
  hostname: string;
  /** An already-connected session, reused from device introspection. */
  ssh: Session;
  /** Opens a fresh session, to reconnect after the commit. */
  connect: () => Promise<Session>;
  state: OpenWrtState;
  /** How the device recovers if the provision is never confirmed. */
  rollbackMode: RollbackMode;
  /** How long the device waits, after reverting, for us to reconnect. */
  recoverSeconds: number;
  sleep: (ms: number) => Promise<void>;
  /** The clock deadlines are measured on (Date.now; virtual in tests). */
  now: () => number;
  timing: ConfirmTiming;
  /** Where the device is, as data (applyEvents.ts); the log says it in words. */
  report?: Reporter;
  /** The state hash the reviewed plan was read from (src/deviceState.ts): planning refuses a device that differs. */
  verify?: { hash: string; sha256: (text: string) => string };
};

export type DeviceRun = DeviceRunOptions & {
  /** Unique per device and run: names everything the run keeps on the device. */
  runId: string;
  installedPackages: string[];
  managedFiles: string[];
  removalCascade: string[];
  /** What the agent's prepare is given: owned configs to seed, packages (getDeviceScript.ts). */
  prepareRecords: AgentRecord[];
  /** Set by configure: the configs to commit depend on the config it read. */
  finaliseRecords?: AgentRecord[];
  /** The run_after_reload hooks, run once the config is live. */
  hooks: string[];
  /** Every declared service enabled and started: over the first reconnect, before confirming. */
  serviceRecords: AgentRecord[];
  /** Services that must have a running process once the run is done. */
  servicesToCheck: string[];
  /** Package or file changes, which only the watchdog can undo. */
  hasIrreversibleSteps: boolean;
  /** Set by arm: when the watchdog started, and when it will fire. */
  armedAt?: number;
  deadline?: number;
};

/** What a phase that went wrong leaves on the device. */
export type Left = {
  /** This device's change had been committed (or may have been, in part). */
  committed: boolean;
  /**
   * Nothing committed, but packages or files may have changed: only its
   * watchdog can undo those, so the run must roll it back, never disarm it.
   */
  leftArmed: boolean;
  /** Reached, but its change cannot stand: roll it back now, not at its deadline. */
  rollBackNow: boolean;
};

/** A phase went wrong: why, and what that leaves on the device. */
export type PhaseFailure = Problem<Left>;

export type Leaves = Partial<Left>;

/** "failed" when the device did not do it; "unreachable" when what it did is not known. */
export const failure = (message: string, leaves: Leaves = {}, kind: ProblemKind = "failed"): PhaseFailure =>
  problem(kind, message, { committed: false, leftArmed: false, rollBackNow: false, ...leaves });

export type PhaseResult<T = DeviceRun> = Result<T, PhaseFailure>;

/**
 * Run a phase's body: the one place anything it throws (a dropped session,
 * an answer that cannot be read) becomes its failure, with `ifThrown` saying
 * what such a failure may have left on the device.
 */
export const guarded = async <T>(body: () => Promise<PhaseResult<T>>, ifThrown: Leaves = {}): Promise<PhaseResult<T>> => {
  const result = await attempt(body, (thrown) => failure(messageOf(thrown), ifThrown, "unreachable"));
  return result.ok ? result.value : result;
};

/** Say where a device is, if anyone listens. */
export const step = (run: Pick<DeviceRunOptions, "hostname" | "now" | "report">, deviceStep: DeviceStep) =>
  run.report?.({ at: run.now(), device: run.hostname, step: deviceStep });

/**
 * A failing hook, as the log says it: its first line, before any heredoc, a
 * quoted value or an assignment (it is the config's own command, and may
 * hold a secret), and short. The log is kept and shown in the UI.
 */
export const commandLabel = (command: string) => {
  const first = command.split("\n")[0].split(/<<|'|=/)[0].trim();
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
};
