// Read every device's status now, all at once, and interpret it against the
// saved settings: everything every Status page shows, in one read. The
// collector (collector.ts) makes it and keeps the result; pages read that.
// Stored beside it: what locating learnt about where a device is
// (src/locate.ts), kept with its facts, and the events Activity keeps
// (written only when new ones came).
import type { OpenWrtConfig } from "../engine/openWrtState";
import { z } from "zod";
import { readFacts } from "../deviceFacts";
import { loadSettings } from "../settings";
import { Platform } from "../platform";
import { provisionableDevices } from "../apply/provisionConfig";
import { readEach } from "../readEach";
import { getOpenWrtState } from "../engine/getOpenWrtState";
import { jobProgress, jobState, liveState } from "../server/provisionJob";
import { readDeviceStatus } from "./device";
import { NetworkStatus, networkStatus } from "./network";
import { ActivityView, activityViewSchema, activityOf, attentionOf, clientsOf, devicesOf, internetCountersOf, internetOf, keepActivity, radiosOf } from "./views";
import { ok, Result } from "../result";
import { Problem } from "../problem";
import { read, stateLayout, StoreKey, write } from "../store";

/** This app's own last run, as an event: applied, or rolled back. */
const appliesOf = async (intentPath: string, platform: Platform): Promise<ActivityView[]> => {
  const run = await jobState({ intentPath, files: platform }).catch(() => undefined);
  if (!run?.startedAt || run.state === "running" || run.state === "idle") return [];
  const outcome = jobProgress(intentPath, platform).outcome;
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

const activityKey = (intentPath: string): StoreKey<ActivityView[]> => ({
  path: stateLayout(intentPath).activity,
  schema: z.array(activityViewSchema),
  format: 1,
  // Before the store: the list as written.
  upgrade: (stored, format) => (format === undefined ? stored : undefined),
});

/** Activity kept beside the intent across reads (device logs roll over), with what was just read. */
const keptActivity = (intentPath: string, platform: Platform, fresh: ActivityView[], applies: ActivityView[]) => {
  const kept = read(platform, activityKey(intentPath)) ?? [];
  const all = keepActivity(kept, [...fresh, ...applies]);
  // Written only when something new came, and whole (a router keeps it in
  // flash, and two readers may overlap): a read that learnt nothing writes nothing.
  if (JSON.stringify(all) !== JSON.stringify(kept)) {
    try {
      write(platform, activityKey(intentPath), all);
    } catch {
      // Kept next time.
    }
  }
  return all.slice(0, 300);
};

/**
 * A device slower than this is reported as not reached, so one cannot hold
 * up the rest; finding it may take a couple of addresses' tries.
 */
const timeoutMs = 12000;

/**
 * The devices smart queueing shapes there, as the engine fitted them (a
 * line's port is only known once its device's ports are: the compiled
 * config, not the intent, names it).
 */
const shapedInterfaces = (config: OpenWrtConfig | undefined) =>
  (config?.sqm?.queue ?? []).filter((queue) => queue.enabled === true || queue.enabled === "1").map((queue) => String(queue.interface));

export const readNetworkStatus = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  now?: () => number;
}): Promise<Result<NetworkStatus, Problem>> => {
  const loaded = await loadSettings(intentPath, platform);
  if (!loaded.ok) return loaded;
  const { plan, intent } = loaded.value;
  const { ready } = provisionableDevices(plan);
  const known = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  // From the compiled settings, per device: what must run, and (the router)
  // what smart queueing shapes, for the Internet checks.
  const compiled = (hostname: string) => {
    const deviceConfig = ready.find((d) => d.hostname === hostname);
    const schema = known[hostname]?.schema;
    if (!deviceConfig || !schema) return undefined;
    try {
      return getOpenWrtState({ plan, deviceConfig, deviceSchema: schema });
    } catch {
      return undefined;
    }
  };
  const devices = await readEach({
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
      const shaped = shapedInterfaces(state?.config);
      return readDeviceStatus(f.hostname, f.session, now, mustRun, {
        ...(router ? { internet: { shaped } } : {}),
        log: true,
        meshWired: true,
        traffic: true,
        heardBy: true,
      });
    },
  });
  // Again: locating may have learnt where a device is now.
  const facts = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  const counters = internetCountersOf(intent, devices);
  const check = internetOf(intent, devices);
  const applied = liveState(intentPath, platform);
  return ok({
    ...networkStatus(intent, devices, Object.fromEntries(Object.entries(facts).map(([name, f]) => [name, f?.macs]))),
    attention: attentionOf({ intent, devices, facts, ...(applied ? { applied } : {}) }),
    clientList: clientsOf(intent, devices, facts),
    deviceViews: devicesOf(intent, devices, facts),
    radios: radiosOf(devices),
    ...(counters ? { internetCounters: counters } : {}),
    ...(check ? { internetCheck: check } : {}),
    activity: keptActivity(intentPath, platform, activityOf(intent, devices), await appliesOf(intentPath, platform)),
  });
};
