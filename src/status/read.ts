// Read every device's status now, all at once, and interpret it against the
// saved settings. Only while someone is looking: each Status page polls its
// view while it is open. Nothing is stored but what locating learnt about
// where a device is (src/locate.ts), kept with its facts, and the events
// Activity keeps (written only when new ones came).
import { readFacts } from "../deviceFacts";
import { loadOncConfig } from "../loadConfig";
import { Platform } from "../platform";
import { provisionableDevices } from "../provisionConfig";
import { readEach } from "../readEach";
import { getOpenWrtState } from "../getOpenWrtState";
import { provisionStatus } from "../server/provisionJob";
import { readDeviceStatus } from "./device";
import { NetworkStatus, networkStatus, Reachability } from "./network";
import { ActivityView, activityOf, attentionOf, clientsOf, devicesOf, internetCountersOf, internetOf, keepActivity, radiosOf } from "./views";
import { parseJson } from "../parseJson";

/** This app's own last run, as an event: applied, or rolled back. */
const appliesOf = async (intentPath: string, platform: Platform): Promise<ActivityView[]> => {
  const run = await provisionStatus({ intentPath, files: platform }).catch(() => undefined);
  if (!run?.startedAt || run.state === "running" || run.state === "idle") return [];
  const outcome = run.progress.outcome;
  const text =
    run.state === "succeeded"
      ? "Settings applied"
      : run.state === "applied-with-problems"
        ? "Settings applied, with a problem after"
        : outcome === "rolled-back"
          ? "An apply was rolled back: every device kept its settings"
          : "An apply stopped before changing anything";
  return [{ at: run.startedAt, device: "This app", text, kind: run.state === "succeeded" ? "apply" : "problem" }];
};

/** Activity kept beside the intent across reads (device logs roll over), with what was just read. */
const keptActivity = (intentPath: string, platform: Platform, fresh: ActivityView[], applies: ActivityView[]) => {
  const file = `${intentPath}.state/activity.json`;
  let kept: ActivityView[] = [];
  try {
    const value = parseJson(platform.readTextFile(file), file);
    if (Array.isArray(value)) kept = value as ActivityView[];
  } catch {
    // None kept yet.
  }
  const all = keepActivity(kept, [...fresh, ...applies]);
  // Written only when something new came, and whole (a router keeps it in
  // flash, and two readers may overlap): a read that learnt nothing writes nothing.
  if (JSON.stringify(all) !== JSON.stringify(kept)) {
    try {
      platform.mkdirp(`${intentPath}.state`);
      platform.writeFileAtomic(file, JSON.stringify(all), 0o600);
    } catch {
      // Kept next time.
    }
  }
  return all.slice(0, 300);
};

/** A Status page's view: each reads what all read, and some a little more (see StatusExtras). */
export const statusViews = ["overview", "clients", "performance", "devices", "activity"] as const;
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
    facts: known,
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
        ...(view === "performance" && router ? { internet: { shaped } } : {}),
        ...(view === "activity" ? { log: true } : {}),
        meshWired: view === "overview",
        traffic: view === "clients",
        heardBy: view === "clients" || view === "performance",
      });
    },
    failed: (hostname, error) => ({ hostname, error }),
  });
  // Again: locating may have learnt where a device is now.
  const facts = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  const counters = internetCountersOf(intent, read);
  const check = view === "performance" ? internetOf(intent, read) : undefined;
  const applied = (await provisionStatus({ intentPath, files: platform }).catch(() => undefined))?.live;
  return {
    ...networkStatus(intent, read, Object.fromEntries(Object.entries(facts).map(([name, f]) => [name, f?.macs]))),
    attention: attentionOf({ intent, devices: read, facts, ...(applied ? { applied } : {}) }),
    clientList: clientsOf(intent, read, facts),
    deviceViews: devicesOf(intent, read, facts),
    radios: radiosOf(read),
    ...(counters ? { internetCounters: counters } : {}),
    ...(check ? { internetCheck: check } : {}),
    ...(view === "activity" ? { activity: keptActivity(intentPath, platform, activityOf(intent, read), await appliesOf(intentPath, platform)) } : {}),
  };
};
