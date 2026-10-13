// Why something asked for could not be done: in the user's words, and of what
// kind, which is all a transport needs to answer it (the web API turns each
// kind into a status in one place, src/server/router.ts). The one failure
// type: expected failures travel as a Result's error (src/result.ts), with
// whatever typed extras their caller needs (`Problem<{ device: string }>`
// for a device read, the apply phases' `committed` and `leftArmed`); a throw
// is a bug.
import { err, Err } from "./result";

export type ProblemKind =
  /** What was asked is not well formed. */
  | "invalid"
  /** No such thing. */
  | "not-found"
  /** It cannot be done in the state things are in (invalid settings, changed elsewhere, an apply running). */
  | "conflict"
  /** One is already running. */
  | "busy"
  /** A device or service could not be reached. */
  | "unreachable"
  /** It was tried on a device or service and did not work. */
  | "failed"
  /** No session, or a wrong password. */
  | "unauthorized"
  /** Not allowed, whoever asks (a missing CSRF header, a host not ours). */
  | "forbidden"
  /** Too many tries: wait. */
  | "rate-limited"
  /** Not something this can be asked to do (a method a route has no handler for). */
  | "unsupported"
  /** Something went wrong here, not on a device: a bug, a file that would not write. */
  | "internal";

export type Problem<X extends object = {}> = {
  kind: ProblemKind;
  message: string;
  /** More for the page beside the message (a save's issues, say), sent as is. */
  details?: Record<string, unknown>;
} & X;

/** A problem, with its typed extras (none by default). */
export const problem = <X extends object = {}>(kind: ProblemKind, message: string, extras?: X & { details?: Record<string, unknown> }): Problem<X> =>
  ({ kind, message, ...(extras ?? {}) }) as Problem<X>;

/** A failed Result carrying a Problem. */
export const fail = <X extends object = {}>(kind: ProblemKind, message: string, extras?: X & { details?: Record<string, unknown> }): Err<Problem<X>> =>
  err(problem(kind, message, extras));
