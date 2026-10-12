// Read every device's status now, all at once, and interpret it against the
// saved settings. Only while someone is looking: the Overview polls it while
// it is open. Nothing is stored but what locating learnt about where a device
// is (src/locate.ts), kept with its facts.
import { clearFailure, factsMaxAgeMs, readFacts, rememberLocated } from "../deviceFacts";
import { loadOncConfig } from "../loadConfig";
import { locateEach } from "../locate";
import { Platform } from "../platform";
import { provisionableDevices } from "../provisionConfig";
import { readDeviceStatus } from "./device";
import { NetworkStatus, networkStatus, Reachability } from "./network";

/**
 * A device slower than this is reported as not reached, so one cannot hold
 * up the rest; finding it may take a couple of addresses' tries.
 */
const timeoutMs = 12000;

export const readNetworkStatus = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  now?: () => number;
}): Promise<NetworkStatus | undefined> => {
  const { oncConfig, intent } = await loadOncConfig({ path: intentPath, platform });
  if (!intent) return undefined;
  const { ready } = provisionableDevices(oncConfig);
  const facts = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  const read = await Promise.all(
    locateEach({ devices: ready, facts, platform }).map((found, i) => {
      const { hostname } = ready[i];
      // Both settle to a result, never a rejection: the loser of the race
      // settles later with no one listening, which must not crash the server.
      // The session is closed however late the device answers.
      const attempt = found
        .then(async (f): Promise<Reachability> => {
          if (!("session" in f)) return { hostname, error: f.error };
          try {
            const known = facts[hostname];
            if (!known || known.address !== f.address || now() - known.readAt > factsMaxAgeMs) {
              rememberLocated(platform, intentPath, f, now());
              clearFailure(platform, intentPath, hostname);
            }
            return await readDeviceStatus(hostname, f.session, now);
          } finally {
            f.session.dispose();
          }
        })
        .catch((e) => ({ hostname, error: (e as Error).message }));
      const late = platform.sleep(timeoutMs).then(() => ({ hostname, error: "did not answer in time" }));
      return Promise.race([attempt, late]);
    })
  );
  return networkStatus(intent, read);
};
