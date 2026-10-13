// Provisioning a whole network as one change: every device is confirmed, or
// every device is rolled back.
//
//   1. plan every device (verify, read state)          — nothing changes
//   2. stage, then arm, every device's rollback          — snapshots only
//   3. configure and commit each, gateway and self last
//   4. confirm every device; only then disarm them all
//
// Any failure in 3 or 4 rolls back every device already committed, now
// rather than when its window runs out. A single device is just N = 1.
import { Reporter, silent } from "./applyEvents";
import {
  armRollback,
  commitDevice,
  discardRollback,
  configureDevice,
  confirmDevice,
  DeviceRun,
  DeviceRunOptions,
  disarmDevice,
  ensureTimeToConfirm,
  planDevice,
  ProvisionFailure,
  rollBackNow,
  runPostReloadHooks,
  checkServices,
  stageRollback,
  startServices,
  waitForRecovery,
  AppliedWithProblems,
  RolledBack,
} from "./devicePhases";
import { reconnectUntil } from "./confirm";
import { Session } from "./platform";

/** Services that should be running and are not: said plainly, not fatal. */
const warnAbout = (problems: string[]) =>
  problems.forEach((problem) => console.warn(`Warning: ${problem}.`));

/**
 * Devices reached through others go first (by the config's provision_order,
 * lower first), then the workstation's gateway, then the device running this
 * tool: changing either of those first could cut the path to the rest.
 * Config order is kept within each group.
 */
export const provisioningOrder = <
  T extends { ipAddress: string; ssh: Pick<Session, "local">; order?: number }
>(
  devices: T[],
  gateway?: string
) => {
  const rank = (device: T) =>
    device.ssh.local ? 2 : device.ipAddress === gateway ? 1 : 0;
  return devices
    .map((device, index) => ({ device, index }))
    .sort(
      (a, b) =>
        rank(a.device) - rank(b.device) ||
        (a.device.order ?? 0) - (b.device.order ?? 0) ||
        a.index - b.index
    )
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

/** A new session, retried for a while: the change just made can take the network down briefly. */
const reconnect = (run: DeviceRun, seconds: number) =>
  reconnectUntil({ connect: run.connect, sleep: run.sleep, now: run.now, deadline: run.now() + seconds * 1000 });

/** Its watchdog fires at its deadline: wait for that, then see whether it came back. */
const recoverAfterDeadline = async (run: DeviceRun) => {
  await run.sleep(Math.max(0, (run.deadline ?? 0) - run.now()));
  return waitForRecovery(run);
};

/**
 * Disarm over the confirming session, else over a new one: confirming the
 * devices after it can cut that session. "unreached": neither got in, so its
 * watchdog fires at its deadline.
 */
const disarmLive = async (run: DeviceRun, session: Session) => {
  const attempt = async (live: Session) => ({
    result: (await disarmDevice(run, live)) ? ("disarmed" as const) : ("fired" as const),
    session: live,
  });
  return attempt(session).catch(async () => {
    session.dispose();
    const fresh = await reconnect(run, 15).catch(() => undefined);
    return fresh
      ? attempt(fresh).catch(() => (fresh.dispose(), { result: "unreached" as const, session: undefined }))
      : { result: "unreached" as const, session: undefined };
  });
};

type Outcome = "confirmed" | "rolled back" | "rolling back" | "untouched";

const summary = (outcomes: [DeviceRun, Outcome][]) =>
  outcomes.map(([run, outcome]) => `  ${run.hostname}: ${outcome}`).join("\n");

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
    outcomes.push([
      run,
      (await rollBackNow(run, session)) ? "rolled back" : "rolling back",
    ]);
  }
  for (const run of unreachable) {
    outcomes.push([run, (await recoverAfterDeadline(run)) ? "rolled back" : "rolling back"]);
  }
  // Never changed: each watchdog is stood down, and the device reported as
  // reverted (nothing kept), not confirmed. One that fired already, or cannot
  // be reached, restores its unchanged snapshot: told it recovered once it
  // has, so it does not reboot as well.
  for (const run of untouched) {
    const disarmed = await withLiveSession(run)
      .then(async (live) => {
        try {
          return (await disarmDevice(live, live.ssh, { untouched: true })) || waitForRecovery(live);
        } finally {
          live.ssh.dispose();
        }
      })
      .catch(() => recoverAfterDeadline(run));
    outcomes.push([run, disarmed ? "untouched" : "rolling back"]);
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
}) => {
  const report = options.report ?? silent;
  const at = Date.now;
  try {
    await runNetwork(options);
    report({ at: at(), outcome: "applied" });
  } catch (e) {
    report({
      at: at(),
      outcome: e instanceof AppliedWithProblems ? "applied-with-problems" : e instanceof RolledBack ? "rolled-back" : "failed",
    });
    throw e;
  }
};

const runNetwork = async ({
  devices,
  confirm,
  confirmTimeoutSeconds,
}: {
  devices: DeviceRunOptions[];
  confirm: boolean;
  confirmTimeoutSeconds: number;
}) => {
  // 1. Plan: verify every device and read its state. Nothing changes yet.
  const runs: DeviceRun[] = [];
  for (const device of devices) runs.push(await planDevice(device));

  if (!confirm) {
    // No rollback to arm, so nothing to undo either: stop at the first failure.
    for (const planned of runs) {
      const run = await configureDevice(await withLiveSession(planned));
      await commitDevice(run);
      run.ssh.dispose();
      // The commit may have severed that session: what follows runs over a
      // new one, as a confirmed run's does.
      const session = await reconnect(run, 60);
      try {
        await startServices(run, session);
        await runPostReloadHooks(run, session);
        warnAbout(await checkServices(run, session));
      } finally {
        session.dispose();
      }
      console.log(`Provisioned ${run.hostname} (unconfirmed).`);
    }
    return;
  }

  // 2. Stage every device's rollback, then arm each, before changing any, so
  // all can be rolled back. Staging fetches packages, which can take a while:
  // done for all first, it eats no device's window.
  const timeoutSeconds = confirmTimeoutSeconds * runs.length;
  const staged: DeviceRun[] = [];
  const armed: DeviceRun[] = [];
  try {
    for (const run of runs) staged.push(await stageRollback(run));
    for (const run of staged) armed.push(await armRollback(run, { timeoutSeconds }));
  } catch (e) {
    await abort({ committed: [], untouched: armed });
    await Promise.all(staged.slice(armed.length).map(discardRollback));
    throw e;
  }
  const earliestDeadline = Math.min(...armed.map((run) => run.deadline!));

  // 3. Configure and commit each device in turn.
  const committed: DeviceRun[] = [];
  for (let i = 0; i < armed.length; i++) {
    let run = armed[i];
    try {
      run = await configureDevice(await withLiveSession(run));
      await ensureTimeToConfirm(run, earliestDeadline, committed.length + 1);
      await commitDevice(run);
      committed.push(run);
    } catch (e) {
      const failure = e instanceof ProvisionFailure ? e : new ProvisionFailure((e as Error)?.message ?? String(e));
      // A failed commit may have persisted part of the change, and a failed
      // configure may have changed packages or files and left its watchdog
      // armed for them: either way roll it back with the rest, never disarm it.
      const changed = failure.committed || failure.leftArmed;
      const outcomes = await abort({
        committed: [...committed, ...(changed ? [run] : [])].map((r) => ({ run: r })),
        untouched: [...(changed ? [] : [run]), ...armed.slice(i + 1)],
      });
      // Changed somewhere and undone, or stopped before anything changed.
      const undone = committed.length > 0 || changed;
      const message = `${failure.message}\nNo device keeps a change from this run:\n${summary(outcomes)}`;
      throw undone ? new RolledBack(message) : new Error(message);
    }
  }

  // 4. Confirm every device; disarm only once all are confirmed.
  const confirmed: { run: DeviceRun; session: Session }[] = [];
  for (const run of committed) {
    run.ssh.dispose();
    try {
      // By the earliest watchdog's deadline, not its own: nothing is disarmed
      // until every device is confirmed, and that one fires first.
      confirmed.push({ run, session: await confirmDevice({ ...run, deadline: earliestDeadline }) });
    } catch (e) {
      const notYetTried = committed.slice(committed.indexOf(run) + 1);
      // Reached but its commit incomplete: rolled back now with the rest.
      if ((e as ProvisionFailure).rollBackNow) {
        const outcomes = await abort({
          committed: [...confirmed, { run }, ...notYetTried.map((r) => ({ run: r }))],
          untouched: [],
        });
        throw new RolledBack(`${(e as Error).message} No device keeps a change from this run:\n${summary(outcomes)}`);
      }
      const outcomes = await abort({
        committed: [...confirmed, ...notYetTried.map((r) => ({ run: r }))],
        untouched: [],
        unreachable: [run],
      });
      // Its own watchdog undid it at its deadline; abort said how that went
      // (rolled back, or still recovering), so nothing is reported over it.
      throw new RolledBack(
        `Provisioning was rolled back: the new configuration cut off access to ` +
          `${
            run.hostname
          }, so no device keeps a change from this run:\n${summary(outcomes)}`
      );
    }
  }

  // In arming order, which is deadline order: the one likeliest to have fired
  // first. One that fired is rolling back already, and one that cannot be
  // reached will at its deadline: undo the rest with it.
  const live: { run: DeviceRun; session: Session }[] = [];
  for (const [i, { run, session }] of confirmed.entries()) {
    const disarmed = await disarmLive(run, session);
    if (disarmed.result === "disarmed") {
      live.push({ run, session: disarmed.session });
      continue;
    }
    const kept = live.map((c) => c.run.hostname);
    live.forEach((c) => c.session.dispose());
    const rest = confirmed.slice(i + 1);
    const outcomes =
      disarmed.result === "fired"
        ? [
            [run, (await waitForRecovery(run)) ? "rolled back" : "rolling back"] as [DeviceRun, Outcome],
            ...(await abort({ committed: rest, untouched: [] })),
          ]
        : await abort({ committed: rest, untouched: [], unreachable: [run] });
    throw new RolledBack(
      (disarmed.result === "fired"
        ? `${run.hostname} rolled itself back before it could be confirmed (its rollback window ran out).`
        : `${run.hostname} could not be reached to confirm it, so it rolls itself back.`) +
        (kept.length ? ` Already confirmed, and keeping the change: ${kept.join(", ")}.` : "") +
        `\n${summary(outcomes)}`
    );
  }

  // After disarming: the config is live everywhere, which is what the hooks
  // need, and a hook failing should not roll back a healthy network.
  const hookFailures: string[] = [];
  for (const { run, session } of live) {
    try {
      await runPostReloadHooks(run, session);
      warnAbout(await checkServices(run, session));
    } catch (e) {
      hookFailures.push((e as Error).message);
    } finally {
      session.dispose();
    }
  }
  if (hookFailures.length > 0) {
    throw new AppliedWithProblems(
      `Applied to every device, but a step after it failed:\n${hookFailures.join("\n")}`
    );
  }
  console.log(
    `Provisioning completed: ${live.length} device(s) confirmed.`
  );
};
