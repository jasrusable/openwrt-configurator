// How a whole run ended, as a value: what provisionNetwork returns, the run's
// last event reports, and the CLI turns into its exit status
// (src/cli/provision.ts).
import { Problem } from "../problem";
import { Result } from "../result";

/** A run that did not simply apply: how it ended instead. */
export type RunEnd =
  /** Every device confirmed and kept its change, but a step after it (a hook) failed: applied, not rolled back. */
  | "applied-with-problems"
  /** A device's change was committed and then undone: the run applied nothing. */
  | "rolled-back"
  /** Stopped before anything was committed. */
  | "failed";

export type RunFailure = Problem<{ end: RunEnd }>;

/** Applied: every device confirmed, how many. */
export type RunResult = Result<{ confirmed: number }, RunFailure>;

/** The exit status of a run applied everywhere with a problem after it, so the UI does not say otherwise. */
export const appliedWithProblemsExit = 3;

/** Exit statuses that mean the change is on the devices. */
export const appliedExits = [0, appliedWithProblemsExit];
