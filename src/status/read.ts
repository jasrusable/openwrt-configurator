// Read every device's status now, all at once, and interpret it against the
// saved settings. Only while someone is looking: the Overview polls it while
// it is open. Nothing is stored.
import { loadOncConfig } from "../loadConfig";
import { Platform } from "../platform";
import { connectToDevice, provisionableDevices } from "../provisionConfig";
import { readDeviceStatus } from "./device";
import { NetworkStatus, networkStatus, Reachability } from "./network";

/** A device slower than this is reported as not reached, so one cannot hold up the rest. */
const timeoutMs = 8000;

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
  const read = await Promise.all(
    ready.map(async (deviceConfig): Promise<Reachability> => {
      const { hostname } = deviceConfig;
      // Both settle to a result, never a rejection: the loser of the race
      // settles later with no one listening, which must not crash the server.
      const attempt = (async (): Promise<Reachability> => {
        const ssh = await connectToDevice({ deviceConfig, platform });
        try {
          return await readDeviceStatus(hostname, ssh, now);
        } finally {
          ssh.dispose();
        }
      })().catch((e) => ({ hostname, error: (e as Error).message }));
      const late = platform.sleep(timeoutMs).then(() => ({ hostname, error: "did not answer in time" }));
      return Promise.race([attempt, late]);
    })
  );
  return networkStatus(intent, read);
};
