// Every device located (src/locate.ts) and read at once, each within a time
// limit, so one slow device cannot hold up the rest. Where a device was found
// is remembered with its facts; nothing it says is stored.
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
import { loadOncConfig } from "./loadConfig";
import { Located, locateEach } from "./locate";
import { withLock } from "./lock";
import { Platform } from "./platform";
import { ProvisionableDevice, provisionableDevices } from "./provisionConfig";

export const readEach = <T>({
  intentPath,
  platform,
  devices,
  facts,
  timeoutMs,
  now = Date.now,
  read,
  failed,
}: {
  intentPath: string;
  platform: Platform;
  devices: ProvisionableDevice[];
  facts: Record<string, DeviceFacts | undefined>;
  timeoutMs: number;
  now?: () => number;
  read: (found: Located) => Promise<T>;
  failed: (hostname: string, error: string) => T;
}): Promise<T[]> =>
  Promise.all(
    locateEach({ devices, facts, platform }).map((found, i) => {
      const { hostname } = devices[i];
      // Both settle to a result, never a rejection: the loser of the race
      // settles later with no one listening, which must not crash the server.
      // The session is closed however late the device answers, and if it
      // answers then hangs, when the time is up.
      let session: Located["session"] | undefined;
      const attempt = found
        .then(async (f): Promise<T> => {
          if (!("session" in f)) return failed(hostname, f.error);
          session = f.session;
          try {
            const known = facts[hostname];
            if (!known || known.address !== f.address || now() - known.readAt > factsMaxAgeMs) {
              rememberLocated(platform, intentPath, f, now());
              clearFailure(platform, intentPath, hostname);
            }
            return await read(f);
          } finally {
            f.session.dispose();
          }
        })
        .catch((e) => failed(hostname, (e as Error).message));
      const late = platform.sleep(timeoutMs).then(() => {
        try {
          session?.dispose();
        } catch {
          // Already closed.
        }
        return failed(hostname, "did not answer in time");
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
  const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
  const { ready } = provisionableDevices(oncConfig);
  const hostnames = ready.map((d) => d.hostname);
  const facts = readFacts(platform, intentPath, hostnames);
  const stale = staleDevices({ facts, failures: readFailures(platform, intentPath, hostnames), now: now() });
  if (stale.length === 0) return;
  await withLock(platform, `${intentPath}.state/devices/.reading`, 1, async () => {
    const devices = ready.filter((d) => stale.includes(d.hostname) || d.tags?.role === "router");
    // Finding a device whose facts are stale keeps them (above).
    const results = await readEach<string | undefined>({
      intentPath,
      platform,
      devices,
      facts,
      timeoutMs: refreshTimeoutMs,
      now,
      read: async () => undefined,
      failed: (_, error) => error,
    });
    results.forEach((error, i) => {
      const { hostname } = devices[i];
      if (error !== undefined && stale.includes(hostname)) recordFailure(platform, intentPath, hostname, { at: now(), error });
    });
  });
};
