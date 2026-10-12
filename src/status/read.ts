// Read every device's status now, all at once, and interpret it against the
// saved settings. Only while someone is looking: the Overview polls it while
// it is open. Nothing is stored but what locating learnt about where a device
// is (src/locate.ts), kept with its facts.
import { readFacts } from "../deviceFacts";
import { loadOncConfig } from "../loadConfig";
import { Platform } from "../platform";
import { provisionableDevices } from "../provisionConfig";
import { readEach } from "../readEach";
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
  const read = await readEach<Reachability>({
    intentPath,
    platform,
    devices: ready,
    facts: readFacts(platform, intentPath, ready.map((d) => d.hostname)),
    timeoutMs,
    now,
    read: (f) => readDeviceStatus(f.hostname, f.session, now),
    failed: (hostname, error) => ({ hostname, error }),
  });
  const facts = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  return networkStatus(
    intent,
    read,
    Object.fromEntries(Object.entries(facts).map(([name, f]) => [name, f?.macs]))
  );
};
