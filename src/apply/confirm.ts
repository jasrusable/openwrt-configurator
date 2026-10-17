// Confirm: reconnect after the commit, once the device's services have
// settled, and check the commit finished. Leaves the rollback armed:
// disarming is its own step, so a run over several devices confirms them all
// before disarming any.
import * as agent from "../agent";
import { reachableSession, reconnectIntervalMs, reconnectSettled } from "./reconnect";
import { commandTimeoutMs, Session } from "../platform";
import { err, ok } from "../result";
import { DeviceRun, failure, PhaseResult, scrubbed, step } from "./run";

/** Left of the window for the confirm after the services start: two reconnects' worth. */
const servicesMarginMs = 30_000;
/** Any less, and a services step cannot do its work at all. */
const minimumServicesMs = 15_000;

/**
 * Enable and start (or stop and disable) the declared services, over a
 * session after the commit. A failure is said, not returned: what decides the
 * run is whether the device can still be reached.
 */
export const startServices = async (run: DeviceRun, session: Session) => {
  if (run.serviceRecords.length === 0) return;
  // Within what is left of the window, short of the confirm itself: one
  // that hangs (a service's start never returning) must not use it all.
  const left = run.deadline === undefined ? undefined : run.deadline - run.now() - servicesMarginMs;
  const timeoutMs = left === undefined ? undefined : Math.max(minimumServicesMs, Math.min(commandTimeoutMs, left));
  const started = await agent.call(session, agent.services(run.runId, run.serviceRecords, timeoutMs));
  if (!started.ok) console.warn(`${run.hostname}: starting its services: ${started.error.message}`);
  else if (!started.value.done) console.warn(`${run.hostname}: starting its services, at ${started.value.step}: ${scrubbed(run, started.value.stderr)}`);
};

export const confirmDevice = async (run: DeviceRun): Promise<PhaseResult<Session>> => {
  const { connect, ipAddress, hostname, sleep } = run;
  step(run, "confirming");
  console.log(run.ssh.local ? `Confirming that ${ipAddress} still answers SSH...` : `Reconnecting to ${hostname} to confirm...`);
  const session = await reconnectSettled({
    connect,
    // Started before the settle and the confirming reconnect: what they
    // change (a stopped firewall's rules) is then inside the rollback.
    beforeSettle: (first) => startServices(run, first),
    confirmWith: reachableSession({ connect, host: ipAddress }),
    // Leave a margin so the last attempt still lands before the watchdog fires.
    deadline: (run.deadline ?? run.now()) - reconnectIntervalMs * 2,
    sleep,
    now: run.now,
  }).catch(() => undefined);
  if (!session) return err(failure(`Could not reconnect to ${hostname} within its confirm window.`, { committed: true }));
  // Reached: but did the commit finish? The link can drop before or during
  // the uci commits as well as during the reload after them.
  const finished = await agent.call(session, agent.commitFinished(run.runId));
  if (!(finished.ok && finished.value)) {
    session.dispose();
    return err(
      failure(`The commit on ${hostname} did not complete before its connection dropped.`, { committed: true, rollBackNow: true })
    );
  }
  return ok(session);
};
