// Provisioning a whole network as one change: every device is confirmed, or
// every device is rolled back.
//
//   1. plan every device (verify, read state; refuse     — nothing changes
//      one changed since its plan was reviewed)
//   2. stage, then arm, every device's rollback          — snapshots only
//   3. configure and commit each, gateway and self last
//   4. confirm every device; only then disarm them all
//
// Any failure in 3 or 4 rolls back every device already committed, now
// rather than when its window runs out. A single device is just N = 1. The
// phases (src/apply/) say how they went as Results; this decides what to undo.
import { Reporter, silent } from "../applyEvents";
import { checkServices, runPostReloadHooks } from "./after";
import { armRollback, discardRollback, installAgent, stageRollback } from "./arm";
import { commitDevice } from "./commit";
import { confirmDevice, startServices } from "./confirm";
import { configureDevice, ensureTimeToConfirm } from "./configure";
import { RunEnd, RunFailure, RunResult } from "./outcome";
import { planDevice } from "./plan";
import { disarmLive, finishRun, reconnect, recoverAfterDeadline, rollBackNow, waitForRecovery } from "./recover";
import { DeviceRun, DeviceRunOptions, guarded, PhaseFailure } from "./run";
import { fail } from "../problem";
import { Err, messageOf, ok, Result } from "../result";
import { Session } from "../platform";

/** Services that should be running and are not: said plainly, not fatal. */
const warnAbout = (problems: string[]) => problems.forEach((problem) => console.warn(`Warning: ${problem}.`));

/**
 * Devices reached through others go first (by the config's provision_order,
 * lower first), then the workstation's gateway, then the device running this
 * tool: changing either of those first could cut the path to the rest.
 * Config order is kept within each group.
 */
export const provisioningOrder = <T extends { ipAddress: string; hostname: string; ssh: Pick<Session, "local">; order?: number }>(
  devices: T[],
  gateway?: string,
  /** The access points this machine is on, by Wi-Fi: after the rest, before the gateway. */
  reachedThrough: string[] = []
) => {
  const rank = (device: T) =>
    device.ssh.local ? 3 : device.ipAddress === gateway ? 2 : reachedThrough.includes(device.hostname) ? 1 : 0;
  return devices
    .map((device, index) => ({ device, index }))
    .sort((a, b) => rank(a.device) - rank(b.device) || (a.device.order ?? 0) - (b.device.order ?? 0) || a.index - b.index)
    .map(({ device }) => device);
};

/** Use the device's session if it is still alive, else open a fresh one. */
const withLiveSession = async (run: DeviceRun): Promise<DeviceRun> => {
  const alive = await run.ssh
    .execCommand("true")
    .then((r) => r.code === 0)
    .catch(() => false);
  if (alive) return run;
  // An earlier device's commit can kill a session opened at the start: an AP
  // behind a freshly reconfigured router is the obvious case.
  console.log(`Session to ${run.hostname} did not survive; reconnecting...`);
  run.ssh.dispose();
  return { ...run, ssh: await run.connect() };
};

/** How the run ended, when it did not simply apply. */
const ended = (end: RunEnd, message: string): Err<RunFailure> => fail(end === "plan-stale" ? "plan-stale" : "failed", message, { end });

type Outcome = "confirmed" | "rolled back" | "rolling back" | "untouched";

const summary = (outcomes: [DeviceRun, Outcome][]) => outcomes.map(([run, outcome]) => `  ${run.hostname}: ${outcome}`).join("\n");

/**
 * Undo the run: roll back every committed device (latest first, now rather
 * than at its deadline) and disarm the ones never touched.
 */
const abort = async ({
  committed,
  untouched,
  unreachable = [],
}: {
  committed: { run: DeviceRun; session?: Session }[];
  untouched: DeviceRun[];
  /** Committed, but cannot be reached: their watchdogs roll them back. */
  unreachable?: DeviceRun[];
}) => {
  const outcomes: [DeviceRun, Outcome][] = [];
  for (const { run, session } of [...committed].reverse()) {
    outcomes.push([run, (await rollBackNow(run, session)) ? "rolled back" : "rolling back"]);
  }
  for (const run of unreachable) {
    outcomes.push([run, (await recoverAfterDeadline(run)) ? "rolled back" : "rolling back"]);
  }
  // Never changed: each watchdog is stood down, and the device reported as
  // reverted (nothing kept), not confirmed. One that fired already, or cannot
  // be reached, restores its unchanged snapshot: told it recovered once it
  // has, so it does not reboot as well.
  for (const run of untouched) {
    const disarmed = await disarmLive(run, run.ssh, { untouched: true });
    if (disarmed.result === "disarmed") await finishRun(run, disarmed.session);
    disarmed.session?.dispose();
    const kept =
      disarmed.result === "disarmed" ||
      (disarmed.result === "fired" ? await waitForRecovery(run) : await recoverAfterDeadline(run));
    outcomes.push([run, kept ? "untouched" : "rolling back"]);
  }
  return outcomes;
};

/**
 * The run, and how it ended as data (applyEvents.ts): applied, applied with a
 * problem after, rolled back (something was committed, then undone), or failed
 * (stopped before anything was committed).
 */
export const provisionNetwork = async (options: {
  /** In provisioning order (see provisioningOrder). */
  devices: DeviceRunOptions[];
  confirm: boolean;
  /** Per device; the run's window is this times the number of devices. */
  confirmTimeoutSeconds: number;
  report?: Reporter;
}): Promise<RunResult> => {
  // Anything thrown (a device that cannot be connected to at all, say)
  // stopped the run before what it would have done.
  const result = await runNetwork(options).catch((thrown) => ended("failed", messageOf(thrown)));
  (options.report ?? silent)({ at: Date.now(), outcome: result.ok ? "applied" : result.error.end });
  return result;
};

/** No rollback to arm, so nothing to undo either: stop at the first failure. */
const runUnconfirmed = async (runs: DeviceRun[]): Promise<RunResult> => {
  for (const planned of runs) {
    // No rollback, but the agent all the same: every step on the device is one of its verbs.
    const installed = await installAgent(await withLiveSession(planned));
    if (!installed.ok) return ended("failed", installed.error.message);
    const configured = await configureDevice(installed.value);
    if (!configured.ok) {
      await finishRun(installed.value, installed.value.ssh);
      return ended("failed", configured.error.message);
    }
    const run = configured.value;
    const committed = await commitDevice(run);
    if (!committed.ok) return ended("failed", committed.error.message);
    run.ssh.dispose();
    // The commit may have severed that session: what follows runs over a
    // new one, as a confirmed run's does.
    const session = await reconnect(run, 60);
    try {
      await startServices(run, session);
      const hooked = await runPostReloadHooks(run, session);
      if (!hooked.ok) return ended("failed", hooked.error);
      warnAbout(await checkServices(run, session));
    } finally {
      await finishRun(run, session);
      session.dispose();
    }
    console.log(`Provisioned ${run.hostname} (unconfirmed).`);
  }
  return ok({ confirmed: 0 });
};

/**
 * Stage every device's rollback, then arm each, before changing any. A
 * failure takes it all back: the armed ones disarmed, the rest's staging
 * dropped, the failed one's included, over a new connection if need be (it
 * may be the link that failed, after its watchdog started). One that cannot
 * be reached then fires at its deadline on an unchanged config, and is told
 * it recovered once it has, so it does not reboot as well.
 */
const armAll = async (runs: DeviceRun[], timeoutSeconds: number): Promise<Result<DeviceRun[], RunFailure>> => {
  const staged: DeviceRun[] = [];
  const armed: DeviceRun[] = [];
  const stop = async (failed: PhaseFailure, pending: DeviceRun[], mayHaveWatchdog?: { run: DeviceRun; armingFrom: number }) => {
    await abort({ committed: [], untouched: armed });
    const gone = await Promise.all(pending.map(discardRollback));
    const stray = mayHaveWatchdog && !gone[pending.indexOf(mayHaveWatchdog.run)];
    if (stray) await recoverAfterDeadline({ ...mayHaveWatchdog.run, deadline: mayHaveWatchdog.armingFrom + timeoutSeconds * 1000 });
    return ended("failed", failed.message);
  };
  // Staging fetches packages, which can take a while: done for all first, it
  // eats no device's window.
  for (const run of runs) {
    const result = await stageRollback(run);
    if (!result.ok) return stop(result.error, [...staged, run]);
    staged.push(result.value);
  }
  for (const [i, run] of staged.entries()) {
    const armingFrom = run.now();
    const result = await armRollback(run, { timeoutSeconds });
    if (!result.ok) return stop(result.error, staged.slice(i), { run, armingFrom });
    armed.push(result.value);
  }
  return ok(armed);
};

/** Configure and commit each device in turn; on a failure, undo the run. */
const configureAll = async (armed: DeviceRun[], earliestDeadline: number): Promise<Result<DeviceRun[], RunFailure>> => {
  const committed: DeviceRun[] = [];
  for (const [i, armedRun] of armed.entries()) {
    const reached = await guarded(async () => ok(await withLiveSession(armedRun)));
    const run = reached.ok ? reached.value : armedRun;
    const configured = reached.ok ? await configureDevice(run) : reached;
    const timely = configured.ok ? await ensureTimeToConfirm(configured.value, earliestDeadline, committed.length + 1) : configured;
    const result = timely.ok ? await commitDevice(timely.value) : timely;
    if (result.ok) {
      committed.push(result.value);
      continue;
    }
    // A failed commit may have persisted part of the change, and a failed
    // configure may have changed packages or files and left its watchdog
    // armed for them: either way roll it back with the rest, never disarm it.
    const changed = result.error.committed || result.error.leftArmed;
    const outcomes = await abort({
      committed: [...committed, ...(changed ? [run] : [])].map((r) => ({ run: r })),
      untouched: [...(changed ? [] : [run]), ...armed.slice(i + 1)],
    });
    // Changed somewhere and undone, or stopped before anything changed.
    const message = `${result.error.message}\nNo device keeps a change from this run:\n${summary(outcomes)}`;
    return ended(committed.length > 0 || changed ? "rolled-back" : "failed", message);
  }
  return ok(committed);
};

/** Confirm every device: none is disarmed until all are. */
const confirmAll = async (
  committed: DeviceRun[],
  earliestDeadline: number
): Promise<Result<{ run: DeviceRun; session: Session }[], RunFailure>> => {
  const confirmed: { run: DeviceRun; session: Session }[] = [];
  for (const [i, run] of committed.entries()) {
    run.ssh.dispose();
    // By the earliest watchdog's deadline, not its own: nothing is disarmed
    // until every device is confirmed, and that one fires first.
    const result = await confirmDevice({ ...run, deadline: earliestDeadline });
    if (result.ok) {
      confirmed.push({ run, session: result.value });
      continue;
    }
    const notYetTried = committed.slice(i + 1).map((r) => ({ run: r }));
    if (result.error.rollBackNow) {
      // Reached but its commit incomplete: rolled back now with the rest.
      const outcomes = await abort({ committed: [...confirmed, { run }, ...notYetTried], untouched: [] });
      return ended("rolled-back", `${result.error.message} No device keeps a change from this run:\n${summary(outcomes)}`);
    }
    // Its own watchdog undoes it at its deadline; abort says how that went.
    const outcomes = await abort({ committed: [...confirmed, ...notYetTried], untouched: [], unreachable: [run] });
    return ended(
      "rolled-back",
      `Provisioning was rolled back: the new configuration cut off access to ${run.hostname}, ` +
        `so no device keeps a change from this run:\n${summary(outcomes)}`
    );
  }
  return ok(confirmed);
};

/**
 * Disarm, in arming order (deadline order: the one likeliest to have fired
 * first). One that fired is rolling back already, and one that cannot be
 * reached will at its deadline: undo the rest with it.
 */
const disarmAll = async (
  confirmed: { run: DeviceRun; session: Session }[]
): Promise<Result<{ run: DeviceRun; session: Session }[], RunFailure>> => {
  const live: { run: DeviceRun; session: Session }[] = [];
  for (const [i, { run, session }] of confirmed.entries()) {
    const disarmed = await disarmLive(run, session);
    if (disarmed.result === "disarmed") {
      live.push({ run, session: disarmed.session });
      continue;
    }
    const kept = live.map((c) => c.run.hostname);
    for (const c of live) await finishRun(c.run, c.session);
    live.forEach((c) => c.session.dispose());
    disarmed.session?.dispose();
    const rest = confirmed.slice(i + 1);
    const outcomes: [DeviceRun, Outcome][] =
      disarmed.result === "fired"
        ? [[run, (await waitForRecovery(run)) ? "rolled back" : "rolling back"], ...(await abort({ committed: rest, untouched: [] }))]
        : await abort({ committed: rest, untouched: [], unreachable: [run] });
    return ended(
      "rolled-back",
      (disarmed.result === "fired"
        ? `${run.hostname} rolled itself back before it could be confirmed (its rollback window ran out).`
        : `${run.hostname} could not be reached to confirm it, so it rolls itself back.`) +
        (kept.length ? ` Already confirmed, and keeping the change: ${kept.join(", ")}.` : "") +
        `\n${summary(outcomes)}`
    );
  }
  return ok(live);
};

const runNetwork = async ({
  devices,
  confirm,
  confirmTimeoutSeconds,
  report = silent,
}: {
  devices: DeviceRunOptions[];
  confirm: boolean;
  confirmTimeoutSeconds: number;
  report?: Reporter;
}): Promise<RunResult> => {
  // 1. Plan: verify every device and read its state. Nothing changes yet.
  const runs: DeviceRun[] = [];
  for (const device of devices) {
    const planned = await planDevice(device);
    if (!planned.ok) return ended(planned.error.kind === "plan-stale" ? "plan-stale" : "failed", planned.error.message);
    runs.push(planned.value);
  }

  if (!confirm) return runUnconfirmed(runs);

  // 2. Stage and arm every device's rollback, so all can be rolled back.
  const armed = await armAll(runs, confirmTimeoutSeconds * runs.length);
  if (!armed.ok) return armed;
  const earliestDeadline = Math.min(...armed.value.map((run) => run.deadline!));
  // The window, for the page: confirm by the earliest deadline; a device not
  // confirmed has its old settings back by its own deadline plus the wait
  // its watchdog gives them before rebooting onto them (agent, watchdog).
  report({
    at: armed.value[0].now(),
    window: {
      confirmBy: earliestDeadline,
      restoredBy: Math.max(...armed.value.map((run) => run.deadline! + run.recoverSeconds * 1000)),
    },
  });

  // 3, 4. Configure and commit each; confirm all; only then disarm.
  const committed = await configureAll(armed.value, earliestDeadline);
  if (!committed.ok) return committed;
  const confirmed = await confirmAll(committed.value, earliestDeadline);
  if (!confirmed.ok) return confirmed;
  const live = await disarmAll(confirmed.value);
  if (!live.ok) return live;

  const hookFailures: string[] = [];
  for (const { run, session } of live.value) {
    const hooked = await runPostReloadHooks(run, session);
    if (!hooked.ok) hookFailures.push(hooked.error);
    else warnAbout(await checkServices(run, session));
    await finishRun(run, session);
    session.dispose();
  }
  if (hookFailures.length > 0) {
    return ended("applied-with-problems", `Applied to every device, but a step after it failed:\n${hookFailures.join("\n")}`);
  }
  console.log(`Provisioning completed: ${live.value.length} device(s) confirmed.`);
  return ok({ confirmed: live.value.length });
};
