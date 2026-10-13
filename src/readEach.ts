// Every device located (src/locate.ts) and read at once, each within a time
// limit, so one slow device cannot hold up the rest. Where a device was found
// is remembered with its facts; nothing it says is stored.
import { problem, Problem, ProblemKind } from "./problem";
import { stateLayout } from "./store";
import {
  clearFailure,
  DeviceFacts,
  factsMaxAgeMs,
  readFacts,
  readFailures,
  recordFailure,
  rememberLocated,
  staleDevices,
} from "./deviceFacts";
import { loadSettings } from "./settings";
import { Located, locateEach } from "./locate";
import { withLock } from "./lock";
import { Platform } from "./platform";
import { ProvisionableDevice, provisionableDevices } from "./apply/provisionConfig";
import { err, messageOf, ok, Result } from "./result";

/** A device that could not be read, and why: not found or not answering (unreachable), or its read went wrong (failed). */
export type DeviceFailure = Problem<{ hostname: string }>;

export const readEach = <T>({
  intentPath,
  platform,
  devices,
  facts,
  timeoutMs,
  now = Date.now,
  read,
}: {
  intentPath: string;
  platform: Platform;
  devices: ProvisionableDevice[];
  facts: Record<string, DeviceFacts | undefined>;
  timeoutMs: number;
  now?: () => number;
  read: (found: Located) => Promise<T>;
}): Promise<Result<T, DeviceFailure>[]> =>
  Promise.all(
    locateEach({ devices, facts, platform }).map((found, i) => {
      const { hostname } = devices[i];
      const failed = (message: string, kind: ProblemKind = "unreachable") => err(problem(kind, message, { hostname }));
      // Both settle to a result, never a rejection: the loser of the race
      // settles later with no one listening, which must not crash the server.
      // The session is closed however late the device answers, and if it
      // answers then hangs, when the time is up.
      let session: Located["session"] | undefined;
      const attempt = found
        .then(async (f): Promise<Result<T, DeviceFailure>> => {
          if (!("session" in f)) return failed(f.error);
          session = f.session;
          try {
            const known = facts[hostname];
            if (!known || known.address !== f.address || now() - known.readAt > factsMaxAgeMs) {
              rememberLocated(platform, intentPath, f, now());
              clearFailure(platform, intentPath, hostname);
            }
            return ok(await read(f));
          } finally {
            f.session.dispose();
          }
        })
        .catch((e) => failed(messageOf(e), "failed"));
      const late = platform.sleep(timeoutMs).then(() => {
        try {
          session?.dispose();
        } catch {
          // Already closed.
        }
        return failed("did not answer in time");
      });
      return Promise.race([attempt, late]);
    })
  );

/** How long one device's facts read may take before it counts as failed. */
const refreshTimeoutMs = 30 * 1000;

/**
 * Read the devices whose facts are stale, at most one read at a time (a lock,
 * so the Node server and CGI requests agree). Each is found first
 * (src/locate.ts), which keeps what it learnt; the router too, as its leases
 * help find the rest. A failure is kept, so the device is not tried again for
 * a while.
 */
export const refreshStale = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  now?: () => number;
}) => {
  // Settings that will not load name no devices to read: the page says why.
  const loaded = await loadSettings(intentPath, platform);
  if (!loaded.ok) return;
  const { ready } = provisionableDevices(loaded.value.plan);
  const hostnames = ready.map((d) => d.hostname);
  const facts = readFacts(platform, intentPath, hostnames);
  const stale = staleDevices({ facts, failures: readFailures(platform, intentPath, hostnames), now: now() });
  if (stale.length === 0) return;
  await withLock(platform, stateLayout(intentPath).readingLock, 1, async () => {
    const devices = ready.filter((d) => stale.includes(d.hostname) || d.tags?.role === "router");
    // Finding a device whose facts are stale keeps them (above).
    const results = await readEach({ intentPath, platform, devices, facts, timeoutMs: refreshTimeoutMs, now, read: async () => undefined });
    results.forEach((result) => {
      if (!result.ok && stale.includes(result.error.hostname)) {
        recordFailure(platform, intentPath, result.error.hostname, { at: now(), error: result.error.message });
      }
    });
  });
};
