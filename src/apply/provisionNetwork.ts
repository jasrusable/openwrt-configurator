// Provisioning a whole network as one change: every device is confirmed, or
// every device is rolled back.
//
//   1. plan every device (verify, read state; refuse     — nothing changes
//      one changed since its plan was reviewed, or
//      under another run's live watchdog)
//   2. stage, then arm, every device's rollback          — snapshots only
//   3. configure and commit each, gateway and self last
//   4. confirm every device; check every watchdog still
//      sleeps with time to spare; only then disarm them all
//
// Any failure in 3 or 4 rolls back every device already committed, now
// rather than when its window runs out. Disarming is the one step that
// cannot be taken back, done a device at a time: one lost then (its link
// gone, its window run out) leaves the run partial, said device by device.
// A single device is just N = 1. The phases (src/apply/) say how they went as
// Results; this decides what to undo.
import { Reporter, silent } from "../applyEvents";
import { checkServices, runPostReloadHooks } from "./after";
import * as agent from "../agent";
import { armRollback, discardRollback, installAgent, stageRollback } from "./arm";
import { commitDevice } from "./commit";
import { confirmDevice, startServices } from "./confirm";
import { configureDevice, ensureTimeToConfirm } from "./configure";
import { RunEnd, RunFailure, RunResult } from "./outcome";
import { planDevice } from "./plan";
import { callLive, disarmLive, finishRun, reconnect, recoverAfterDeadline, rollBackNow, waitForRecovery } from "./recover";
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
const ended = (end: RunEnd, message: string, kept?: string[]): Err<RunFailure> =>
  fail(end === "plan-stale" ? "plan-stale" : "failed", message, { end, ...(kept ? { kept } : {}) });

/**
 * What a rolled-back run leaves, truthfully: nothing of its settings, but
 * what a changed file's run_after did (root's password, which this app logs
 * back in with) no rollback undoes.
 */
const noneKept = (ranAfter: string[]) =>
  ranAfter.length === 0
    ? "No device keeps a change from this run"
    : `No device keeps a change from this run, but what a changed file's run_after did stays, as no rollback undoes it ` +
      `(root's password is one: as this run set it on ${ranAfter.join(", ")})`;

/** The devices among these on which a changed file's run_after ran (or may have). */
const ranAfterOn = (runs: DeviceRun[]) => runs.filter((run) => run.ranAfter).map((run) => run.hostname);

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
  (options.report ?? silent)({
    at: Date.now(),
    outcome: result.ok ? "applied" : result.error.end,
    ...(!result.ok && result.error.kept ? { kept: result.error.kept } : {}),
  });
  return result;
};

/**
 * No rollback to arm, so nothing to undo either: stop at the first failure.
 * How it ended goes by what was committed: nothing, a failure; every device,
 * applied with a problem after; some, partial (each one committed keeps it).
 */
const runUnconfirmed = async (runs: DeviceRun[]): Promise<RunResult> => {
  const applied: string[] = [];
  // `whole`: its commit went through (one that failed may have persisted only part of it).
  const stopped = (message: string, hostname: string, committed: boolean, whole = committed) => {
    const kept = [...applied, ...(committed ? [hostname] : [])];
    if (kept.length === 0) return ended("failed", message);
    if (kept.length === runs.length && whole) return ended("applied-with-problems", message);
    return ended("partial", `${message}\nApplied without a confirm, and kept (wholly or, a failed commit, in part): ${kept.join(", ")}.`, kept);
  };
  for (const planned of runs) {
    let committed = false;
    try {
      // No rollback, but the agent all the same: every step on the device is one of its verbs.
      const installed = await installAgent(await withLiveSession(planned));
      if (!installed.ok) return stopped(installed.error.message, planned.hostname, false);
      const configured = await configureDevice(installed.value);
      if (!configured.ok) {
        await finishRun(installed.value, installed.value.ssh);
        return stopped(configured.error.message, planned.hostname, false);
      }
      const run = configured.value;
      const commit = await commitDevice(run);
      // A failed commit may have persisted part of it.
      committed = true;
      if (!commit.ok) return stopped(commit.error.message, run.hostname, true, false);
      run.ssh.dispose();
      // The commit may have severed that session: what follows runs over a
      // new one, as a confirmed run's does.
      const session = await reconnect(run, 60);
      try {
        await startServices(run, session);
        const hooked = await runPostReloadHooks(run, session);
        if (!hooked.ok) return stopped(hooked.error, run.hostname, true);
        warnAbout(await checkServices(run, session));
      } finally {
        await finishRun(run, session);
        session.dispose();
      }
    } catch (thrown) {
      // A device that cannot be reached again, say: committed or not, it stops here.
      return stopped(messageOf(thrown), planned.hostname, committed);
    }
    applied.push(planned.hostname);
    console.log(`Provisioned ${planned.hostname} (unconfirmed).`);
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
    const ranAfter = [...ranAfterOn(committed), ...(result.error.ranAfter ? [run.hostname] : [])];
    // Changed somewhere and undone, or stopped before anything changed.
    const message = `${result.error.message}\n${noneKept(ranAfter)}:\n${summary(outcomes)}`;
    return ended(committed.length > 0 || changed || ranAfter.length > 0 ? "rolled-back" : "failed", message);
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
      return ended("rolled-back", `${result.error.message} ${noneKept(ranAfterOn(committed))}:\n${summary(outcomes)}`);
    }
    // Its own watchdog undoes it at its deadline; abort says how that went.
    const outcomes = await abort({ committed: [...confirmed, ...notYetTried], untouched: [], unreachable: [run] });
    return ended(
      "rolled-back",
      `Provisioning was rolled back: the new configuration cut off access to ${run.hostname}. ` +
        `${noneKept(ranAfterOn(committed))}:\n${summary(outcomes)}`
    );
  }
  return ok(confirmed);
};

type Confirmed = { run: DeviceRun; session: Session };

/** What each watchdog must still have to sleep when the disarming starts: the devices are disarmed one after another. */
const disarmMarginSeconds = 20;

/**
 * Before any is disarmed: every watchdog still asleep with time to spare, or
 * dead before it restored anything (the change stays there whatever
 * happens). One that fired, cannot be reached, or is about to fire, and the
 * whole run is rolled back, none yet disarmed: a disarm cannot be taken
 * back, so this is the last point where every device can still go together.
 */
const readyToDisarm = async (confirmed: Confirmed[], committed: DeviceRun[]): Promise<Result<Confirmed[], RunFailure>> => {
  const rolledBack = (why: string, outcomes: [DeviceRun, Outcome][]) =>
    ended("rolled-back", `${why}, so the run was rolled back. ${noneKept(ranAfterOn(committed))}:\n${summary(outcomes)}`);
  // Each one asleep, with when it fires on this side's clock; none when its watchdog died asleep.
  const ready: (Confirmed & { firesAt?: number })[] = [];
  for (const [i, { run, session }] of confirmed.entries()) {
    const rest = confirmed.slice(i + 1);
    // From before asking: the device counts its seconds after.
    const askedAt = run.now();
    const got = await callLive(run, session, agent.asleep(run.runId));
    if (!got) {
      // Its own watchdog restores it at its deadline.
      const outcomes = await abort({ committed: [...ready, ...rest], untouched: [], unreachable: [run] });
      return rolledBack(`${run.hostname} could not be reached again before disarming`, outcomes);
    }
    const state = got.answer;
    if (!state.asleep && !state.kept) {
      got.session.dispose();
      const outcomes = await abort({ committed: [...ready, ...rest], untouched: [] });
      const own: [DeviceRun, Outcome] = [run, (await waitForRecovery(run)) ? "rolled back" : "rolling back"];
      return rolledBack(`${run.hostname} rolled itself back before it could be confirmed (its rollback window ran out)`, [...outcomes, own]);
    }
    ready.push({ run, session: got.session, ...(state.asleep ? { firesAt: askedAt + state.seconds * 1000 } : {}) });
    // Every one asked so far still has time to spare now: after the last, as the disarming starts.
    const late = ready.find(({ firesAt }) => firesAt !== undefined && firesAt - run.now() < disarmMarginSeconds * 1000);
    if (late) {
      const left = Math.max(0, Math.round((late.firesAt! - run.now()) / 1000));
      // Still asleep, but too close to firing: woken now with the rest.
      const outcomes = await abort({ committed: [...ready, ...rest], untouched: [] });
      return rolledBack(`Too little of the rollback window was left to disarm every device (${late.run.hostname}: ${left} s)`, outcomes);
    }
  }
  return ok(ready.map(({ run, session }) => ({ run, session })));
};

/**
 * Disarm each, in arming order (deadline order: the one likeliest to fire
 * first). One lost now (it fired, or the link went) cannot be helped by
 * undoing the rest, which would only move more devices off the change:
 * the rest are disarmed too, and the ones lost roll back on their own.
 */
const disarmAll = async (ready: Confirmed[]) => {
  const kept: Confirmed[] = [];
  const lost: { run: DeviceRun; fired: boolean }[] = [];
  for (const { run, session } of ready) {
    const disarmed = await disarmLive(run, session);
    if (disarmed.result === "disarmed") kept.push({ run, session: disarmed.session });
    else {
      disarmed.session?.dispose();
      lost.push({ run, fired: disarmed.result === "fired" });
    }
  }
  return { kept, lost };
};

/** The devices lost as they were disarmed, once each has rolled back (or will): how each came out. */
const lostOutcomes = async (lost: { run: DeviceRun; fired: boolean }[]): Promise<[DeviceRun, Outcome][]> => {
  const outcomes: [DeviceRun, Outcome][] = [];
  for (const { run, fired } of lost) {
    outcomes.push([run, (await (fired ? waitForRecovery(run) : recoverAfterDeadline(run))) ? "rolled back" : "rolling back"]);
  }
  return outcomes;
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
  const ready = await readyToDisarm(confirmed.value, committed.value);
  if (!ready.ok) return ready;
  const { kept, lost } = await disarmAll(ready.value);

  const hookFailures: string[] = [];
  for (const { run, session } of kept) {
    const hooked = await runPostReloadHooks(run, session);
    if (!hooked.ok) hookFailures.push(hooked.error);
    else warnAbout(await checkServices(run, session));
    await finishRun(run, session);
    session.dispose();
  }
  const after = hookFailures.length > 0 ? `\nA step after it failed:\n${hookFailures.join("\n")}` : "";
  if (lost.length > 0) {
    const outcomes = await lostOutcomes(lost);
    const keptNames = kept.map((c) => c.run.hostname);
    const message =
      lost.map(({ run, fired }) => (fired ? `${run.hostname} rolled itself back before it could be disarmed (its rollback window ran out).` : `${run.hostname} could not be reached to disarm it, so it rolls itself back.`)).join(" ") +
      (keptNames.length
        ? ` Already disarmed, and keeping the change: ${keptNames.join(", ")}. The devices are now on different settings: apply again.`
        : ` ${noneKept(ranAfterOn(committed.value))}.`) +
      `\n${summary(outcomes)}${after}`;
    return ended(keptNames.length ? "partial" : "rolled-back", message, keptNames.length ? keptNames : undefined);
  }
  if (hookFailures.length > 0) return ended("applied-with-problems", `Applied to every device, but a step after it failed:\n${hookFailures.join("\n")}`);
  console.log(`Provisioning completed: ${kept.length} device(s) confirmed.`);
  return ok({ confirmed: kept.length });
};
