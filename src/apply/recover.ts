// Disarm, and the ways a committed change is undone: roll back now (something
// else in the run failed) and recover (tell a rolled-back device that access
// came back, so it need not reboot).
import * as agent from "../agent";
import { reachableSession, reconnectUntil } from "./reconnect";
import { Session } from "../platform";
import { Problem } from "../problem";
import { ok, Result } from "../result";
import { DeviceRun, step } from "./run";

/**
 * Stand the watchdog down: the device is reachable and its config stays.
 * "fired" when it came too late (the watchdog had started restoring the old
 * config, or finished); a failure when the session could not ask.
 */
export const disarmDevice = async (
  run: DeviceRun,
  session: Session,
  { untouched = false } = {}
): Promise<Result<"disarmed" | "fired", Problem>> => {
  const answer = await agent.call(session, agent.disarm(run.runId));
  if (!answer.ok) return answer;
  if (untouched) {
    step(run, "reverted");
  } else if (answer.value === "fired") {
    console.error(`${run.hostname} rolled itself back before it could be confirmed.`);
    step(run, "rolling-back");
  } else {
    console.log(`Confirmed ${run.hostname}.`);
    step(run, "confirmed");
  }
  return ok(answer.value);
};

/**
 * After the watchdog has rolled back (on its own, or woken), wait for the
 * device to come back. Whether it has to reboot depends on whether the
 * restore brought access back, which only we can tell it: once it has
 * restored, and a connection gets in, say so. Returns whether it came back.
 */
export const waitForRecovery = async (run: DeviceRun) => {
  const { connect, ipAddress, hostname, sleep, rollbackMode, recoverSeconds } = run;
  if (rollbackMode === "reboot") return false;
  const reachable = reachableSession({ connect, host: ipAddress });
  const back = await reconnectUntil({
    // Each attempt a new connection, until one finds the restore done.
    connect: async () => {
      const session = await reachable();
      const told = await agent.call(session, agent.recovered(run.runId));
      if (told.ok && told.value) return session;
      session.dispose();
      throw new Error(`${hostname} has not restored its config yet`);
    },
    sleep,
    now: run.now,
    // Its own wait starts only after its restore (a package reinstall can take
    // a while) and reload: allow for those, or this gives up on one that comes back.
    deadline: run.now() + recoverSeconds * 1000 + 60_000,
  }).catch(() => undefined);
  if (back) {
    back.dispose();
    console.error(`${hostname} rolled back and recovered without rebooting.`);
    step(run, "rolled-back");
    return true;
  }
  step(run, "recovering");
  console.error(
    `Could not reach ${hostname} after its rollback. ` +
      (rollbackMode === "reload"
        ? `--rollback=reload forbids rebooting, so the device needs manual recovery.`
        : `The device will reboot to finish recovering.`)
  );
  return false;
};

/** A new session, retried for a while: the change just made can take the network down briefly. */
export const reconnect = (run: DeviceRun, seconds: number) =>
  reconnectUntil({ connect: run.connect, sleep: run.sleep, now: run.now, deadline: run.now() + seconds * 1000 });

/** Its watchdog fires at its deadline: wait for that, then see whether it came back. */
export const recoverAfterDeadline = async (run: DeviceRun) => {
  await run.sleep(Math.max(0, (run.deadline ?? 0) - run.now()));
  return waitForRecovery(run);
};

/**
 * Undo a committed change now, because something else in the run failed: wake
 * the watchdog early, then wait for the device to recover. Over the session
 * given, else a new one (a later device's change can cut it); a device that
 * cannot be reached rolls back at its deadline.
 */
export const rollBackNow = async (run: DeviceRun, session?: Session) => {
  console.error(`Rolling back ${run.hostname}...`);
  step(run, "rolling-back");
  const wake = async (live: Session) => {
    const woken = await agent.call(live, agent.wake(run.runId));
    live.dispose();
    return woken.ok && woken.value;
  };
  const woken =
    (session && (await wake(session))) ||
    (await reconnect(run, 15)
      .then(wake)
      .catch(() => false));
  if (!woken) {
    console.error(`Could not start ${run.hostname}'s rollback now; its watchdog starts it at the deadline.`);
    return recoverAfterDeadline(run);
  }
  return waitForRecovery(run);
};

/**
 * The run is over on this device: what it leaves there (its agent, its
 * directories, the disarm's marker), removed. Best effort: a watchdog that
 * fired cleans up after itself.
 */
export const finishRun = async (run: DeviceRun, session: Session) => {
  await agent.call(session, agent.finish(run.runId));
};

export type Disarmed = { result: "disarmed" | "fired"; session: Session } | { result: "unreached"; session: undefined };

/**
 * Disarm over the given session, else over a new one: confirming (or
 * changing) other devices can cut that session, and an answer lost with it
 * is asked again. "unreached": neither got in, so its watchdog fires at its
 * deadline.
 */
export const disarmLive = async (run: DeviceRun, session: Session, options: { untouched?: boolean } = {}): Promise<Disarmed> => {
  const first = await disarmDevice(run, session, options);
  if (first.ok) return { result: first.value, session };
  session.dispose();
  const fresh = await reconnect(run, 15).catch(() => undefined);
  if (!fresh) return { result: "unreached", session: undefined };
  const again = await disarmDevice(run, fresh, options);
  if (again.ok) return { result: again.value, session: fresh };
  fresh.dispose();
  return { result: "unreached", session: undefined };
};
