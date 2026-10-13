// Provisioning a whole network as one change: every device is confirmed, or
// every device is rolled back.
//
//   1. plan every device (verify, read state)          — nothing changes
//   2. arm every device's rollback watchdog             — snapshots only
//   3. configure and commit each, gateway and self last
//   4. confirm every device; only then disarm them all
//
// Any failure in 3 or 4 rolls back every device already committed, now
// rather than when its window runs out. A single device is just N = 1.
import { Reporter, silent } from "./applyEvents";
import {
  armRollback,
  commitDevice,
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
  waitForRecovery,
  AppliedWithProblems,
  RolledBack,
} from "./devicePhases";
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
    // Its watchdog fires at the deadline; then see whether it came back.
    await run.sleep(Math.max(0, (run.deadline ?? 0) - run.now()));
    outcomes.push([
      run,
      (await waitForRecovery(run)) ? "rolled back" : "rolling back",
    ]);
  }
  for (const run of untouched) {
    try {
      const live = await withLiveSession(run);
      // Never changed: its watchdog is stood down, and it is reported as
      // reverted (nothing kept), not confirmed.
      await disarmDevice(live, live.ssh, { untouched: true });
      live.ssh.dispose();
    } catch {
      // Unreachable: its watchdog restores the snapshot, which is unchanged.
    }
    outcomes.push([run, "untouched"]);
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
      // The commit may have severed this session. That is the trade-off
      // --no-confirm asks for; the hooks still cannot fail silently.
      try {
        await runPostReloadHooks(run, run.ssh);
        warnAbout(await checkServices(run, run.ssh));
      } finally {
        run.ssh.dispose();
      }
      console.log(`Provisioned ${run.hostname} (unconfirmed).`);
    }
    return;
  }

  // 2. Arm every device before changing any, so all can be rolled back.
  const timeoutSeconds = confirmTimeoutSeconds * runs.length;
  const armed: DeviceRun[] = [];
  try {
    for (const run of runs)
      armed.push(await armRollback(run, { timeoutSeconds }));
  } catch (e) {
    await abort({ committed: [], untouched: armed });
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
      const failure = e as ProvisionFailure;
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
  // first. One that fired is rolling back already: undo the rest with it.
  for (let i = 0; i < confirmed.length; i++) {
    const { run, session } = confirmed[i];
    if (await disarmDevice(run, session)) continue;
    const kept = confirmed.slice(0, i).map((c) => c.run.hostname);
    const outcomes = await abort({ committed: confirmed.slice(i + 1), untouched: [] });
    throw new RolledBack(
      `${run.hostname} rolled itself back before it could be confirmed (its rollback window ran out).` +
        (kept.length ? ` Already confirmed, and keeping the change: ${kept.join(", ")}.` : "") +
        `\n${summary([[run, "rolled back"], ...outcomes])}`
    );
  }

  // After disarming: the config is live everywhere, which is what the hooks
  // need, and a hook failing should not roll back a healthy network.
  const hookFailures: string[] = [];
  for (const { run, session } of confirmed) {
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
    `Provisioning completed: ${confirmed.length} device(s) confirmed.`
  );
};
