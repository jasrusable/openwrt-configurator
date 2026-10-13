// Proving a device is still reachable after a commit, before disarming its
// rollback: the timing rules, the reconnect loop, and the extra check a device
// provisioning itself needs.
import { answersSsh, runProbe, servicesSettled } from "./deviceProbes";
import { Session } from "./platform";

export const reconnectIntervalMs = 3000;

/** Minimum time that must remain in the rollback window before committing. */
const defaultMinimumConfirmWindowMs = 30000;
/**
 * The confirm window is timed from arming, so it also has to cover configuring.
 * At 30s, the old minimum, there was never 30s left to confirm and every run
 * aborted; allow at least as much again for the configure phase.
 */
const confirmTimingFor = (minimumConfirmWindowMs: number) => ({
  minimumConfirmWindowMs,
  minimumConfirmTimeoutSeconds: (minimumConfirmWindowMs * 2) / 1000,
});

/**
 * The timing rules, optionally with a shorter window for tests: rolling back
 * waits out the whole window, and the rig would otherwise spend minutes
 * sleeping. Never shorter than the 10 s a reconnect and confirm need.
 */
export const confirmTiming = (testWindowSeconds?: string) => {
  const seconds = Number(testWindowSeconds);
  return testWindowSeconds && Number.isFinite(seconds) && seconds >= 10
    ? { ...confirmTimingFor(seconds * 1000), shortened: true }
    : { ...confirmTimingFor(defaultMinimumConfirmWindowMs), shortened: false };
};

export type ConfirmTiming = ReturnType<typeof confirmTiming>;

/**
 * Reconnect, retrying until the deadline.
 *
 * `reload_config` can take the network down briefly, so a single attempt right
 * after committing is likely to fail even on a perfectly healthy device — and
 * treating that as a failure would reboot it for no reason. Keep trying until
 * shortly before the watchdog is due to fire.
 */
export const reconnectUntil = async ({
  connect,
  deadline,
  sleep,
  now = Date.now,
}: {
  connect: () => Promise<Session>;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
  /** The clock `deadline` is on; injected so tests can run on a virtual one. */
  now?: () => number;
}) => {
  let lastError: unknown;
  while (now() < deadline) {
    try {
      const session = await connect();
      // A connection that took past the deadline proves nothing in time:
      // the watchdog may already be restoring.
      if (now() >= deadline) {
        session.dispose();
        throw new Error("Connected only after the deadline");
      }
      return session;
    } catch (e) {
      lastError = e;
      if (now() + reconnectIntervalMs >= deadline) break;
      await sleep(reconnectIntervalMs);
    }
  }
  throw lastError ?? new Error("Timed out reconnecting");
};

/**
 * Reconnecting is how a provision proves the device is still reachable, but a
 * device provisioning itself never loses its own session, so in local mode it
 * would confirm a config that locks everyone else out. There, also require the
 * device's own address to still answer SSH. That catches a removed or changed
 * address and dropbear no longer listening on it; it cannot catch a firewall
 * or cabling change that only affects other hosts, since the check is local.
 */
export const reachableSession =
  ({ connect, host }: { connect: () => Promise<Session>; host: string }) =>
  async () => {
    const session = await connect();
    if (!session.local) return session;
    if (!(await runProbe(session, answersSsh(host)))) {
      session.dispose();
      throw new Error(`${host} is not answering SSH on port 22.`);
    }
    return session;
  };

/**
 * Reconnect, wait for the device's services to settle, then reconnect again
 * and return that second session. The first connection only shows SSH answers
 * right now; what has to hold for the confirm is that a *new* connection still
 * works once every reload has landed. The settle step is skipped quietly if
 * its session drops: the second reconnect is the real test either way.
 */
export const reconnectSettled = async ({
  connect,
  confirmWith,
  beforeSettle,
  deadline,
  sleep,
  now = Date.now,
}: {
  connect: () => Promise<Session>;
  /** Run over the first session, before the services settle. */
  beforeSettle?: (session: Session) => Promise<void>;
  /** How the final, confirming session is obtained (see reachableSession). */
  confirmWith: () => Promise<Session>;
  deadline: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}) => {
  const first = await reconnectUntil({ connect, deadline, sleep, now });
  try {
    await beforeSettle?.(first);
    // Leave at least ten seconds of the window for the second reconnect,
    // counted after beforeSettle, which takes its own share.
    const budget = Math.min(20, (deadline - now()) / 1000 - 10);
    if (budget >= 3) await runProbe(first, servicesSettled(budget));
  } catch {
    // The first session dropped (services restarting the network): skipped
    // quietly, as the confirming reconnect below is the real test.
  } finally {
    first.dispose();
  }
  return reconnectUntil({ connect: confirmWith, deadline, sleep, now });
};
