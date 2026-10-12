// Read every device's status now, all at once, and interpret it against the
// saved settings. Only while someone is looking: the Overview polls it while
// it is open. Nothing is stored but what locating learnt about where a device
// is (src/locate.ts), kept with its facts.
import { readFacts } from "../deviceFacts";
import { loadOncConfig } from "../loadConfig";
import { Platform } from "../platform";
import { provisionableDevices } from "../provisionConfig";
import { readEach } from "../readEach";
import { getOpenWrtState } from "../getOpenWrtState";
import { provisionStatus } from "../server/provisionJob";
import { readDeviceStatus } from "./device";
import { NetworkStatus, networkStatus, Reachability } from "./network";
import { activityOf, attentionOf, clientsOf, devicesOf, internetOf, radiosOf } from "./views";

/** A Status tab: each reads what all read, and some a little more (the Internet checks, the log). */
export const statusViews = ["overview", "clients", "internet", "wifi", "devices", "activity"] as const;
export type StatusView = (typeof statusViews)[number];

/**
 * A device slower than this is reported as not reached, so one cannot hold
 * up the rest; finding it may take a couple of addresses' tries.
 */
const timeoutMs = 12000;

export const readNetworkStatus = async ({
  intentPath,
  platform,
  now = Date.now,
  view = "overview",
}: {
  intentPath: string;
  platform: Platform;
  now?: () => number;
  view?: StatusView;
}): Promise<NetworkStatus | undefined> => {
  const { oncConfig, intent } = await loadOncConfig({ path: intentPath, platform });
  if (!intent) return undefined;
  const { ready } = provisionableDevices(oncConfig);
  const known = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  // From the compiled settings, per device: what must run, and (the router)
  // what smart queueing shapes, for the Internet checks.
  const compiled = (hostname: string) => {
    const deviceConfig = ready.find((d) => d.hostname === hostname);
    const schema = known[hostname]?.schema;
    if (!deviceConfig || !schema) return undefined;
    try {
      return getOpenWrtState({ oncConfig, deviceConfig, deviceSchema: schema });
    } catch {
      return undefined;
    }
  };
  const read = await readEach<Reachability>({
    intentPath,
    platform,
    devices: ready,
    facts: readFacts(platform, intentPath, ready.map((d) => d.hostname)),
    timeoutMs,
    now,
    read: (f) => {
      const state = compiled(f.hostname);
      const mustRun = (state?.services ?? []).filter((s) => s.running && s.enabled !== false).map((s) => s.name);
      const router = ready.find((d) => d.hostname === f.hostname)?.tags?.role === "router";
      const shaped = ((state?.config as any)?.sqm?.queue ?? [])
        .filter((q: any) => q.enabled)
        .map((q: any) => String(q.interface));
      return readDeviceStatus(f.hostname, f.session, now, mustRun, {
        ...(view === "internet" && router ? { internet: { shaped } } : {}),
        ...(view === "activity" ? { log: true } : {}),
      });
    },
    failed: (hostname, error) => ({ hostname, error }),
  });
  const facts = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  const applied = (await provisionStatus({ intentPath, files: platform }).catch(() => undefined))?.live;
  return {
    ...networkStatus(intent, read, Object.fromEntries(Object.entries(facts).map(([name, f]) => [name, f?.macs]))),
    attention: attentionOf({ intent, devices: read, facts, ...(applied ? { applied } : {}) }),
    clientList: clientsOf(intent, read, facts),
    deviceViews: devicesOf(intent, read, facts),
    radios: radiosOf(read),
    ...(view === "internet" && internetOf(intent, read) ? { internetCheck: internetOf(intent, read) } : {}),
    ...(view === "activity" ? { activity: activityOf(intent, read) } : {}),
  };
};
