// Read every device's status now, all at once, and interpret it against the
// saved settings: everything every Status page shows, in one read. The
// collector (collector.ts) makes it and keeps the result; pages read that.
// Stored beside it: what locating learnt about where a device is
// (src/locate.ts), kept with its facts.
import type { OpenWrtConfig } from "../engine/openWrtState";
import { DeviceFacts, readFacts } from "../deviceFacts";
import { loadSettings, SavedSettings } from "../settings";
import type { Intent } from "../intent/schema";
import type { DeviceSchema } from "../deviceSchema";
import { Platform } from "../platform";
import { provisionableDevices, ProvisionableDevice } from "../apply/provisionConfig";
import { readEach } from "../readEach";
import { getOpenWrtState } from "../engine/getOpenWrtState";
import { liveState } from "../apply/job";
import { dohPorts, fallbackOf } from "../intent/dns";
import { meshWiredLink, readDeviceStatus } from "./device";
import { NetworkStatus, networkStatus } from "./network";
import { attentionOf, clientsOf, devicesOf, internetCountersOf, internetOf, radiosOf } from "./views";
import { ok, Result } from "../result";
import { Problem } from "../problem";

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

/** What a device's status is judged against: the services that must run there, and (the router) what is shaped. */
type DeviceExpectations = { mustRun: string[]; shaped: string[] };

/** What a status read takes from the settings: the intent, the devices to read, and each one's expectations. */
export type StatusSettings = {
  intent: Intent;
  ready: ProvisionableDevice[];
  /** Their facts, as they were before this read. */
  facts: Record<string, DeviceFacts | undefined>;
  expected: (hostname: string) => DeviceExpectations;
};

// Kept between reads in one process (the collector reads every 10 s while
// someone looks): the settings load and compile again only when the file
// changes, and a device's state only when its facts do. Secrets are resolved
// at load (a keychain lookup each on a Mac), so a file left as it is keeps them.
let kept: { text: string; settings: SavedSettings } | undefined;
const keptStates = new Map<string, DeviceExpectations>();

const expectationsOf = (settings: SavedSettings, deviceConfig: ProvisionableDevice, schema: DeviceSchema): DeviceExpectations => {
  try {
    const state = getOpenWrtState({ plan: settings.plan, deviceConfig, deviceSchema: schema });
    return {
      mustRun: state.services.filter((s) => s.running && s.enabled !== false).map((s) => s.name),
      shaped: shapedInterfaces(state.config),
    };
  } catch {
    return { mustRun: [], shaped: [] };
  }
};

export const readStatusSettings = async (intentPath: string, platform: Platform): Promise<Result<StatusSettings, Problem>> => {
  const text = (() => {
    try {
      return platform.readTextFile(intentPath);
    } catch {
      return undefined;
    }
  })();
  if (text === undefined || kept?.text !== text) {
    const loaded = await loadSettings(intentPath, platform);
    if (!loaded.ok) return loaded;
    kept = text === undefined ? undefined : { text, settings: loaded.value };
    keptStates.clear();
    if (!kept) return ok(statusSettingsOf(loaded.value, intentPath, platform));
  }
  return ok(statusSettingsOf(kept.settings, intentPath, platform));
};

const statusSettingsOf = (settings: SavedSettings, intentPath: string, platform: Platform): StatusSettings => {
  const { ready } = provisionableDevices(settings.plan);
  const facts = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  return {
    intent: settings.intent,
    ready,
    facts,
    expected: (hostname) => {
      const deviceConfig = ready.find((d) => d.hostname === hostname);
      const schema = facts[hostname]?.schema;
      if (!deviceConfig || !schema) return { mustRun: [], shaped: [] };
      const key = `${hostname}\n${JSON.stringify(schema)}`;
      const known = keptStates.get(key);
      if (known) return known;
      const made = expectationsOf(settings, deviceConfig, schema);
      keptStates.set(key, made);
      return made;
    },
  };
};

/** The DNS-over-HTTPS instances the router runs, by port: the provider's, then the fallback's. */
const dohOf = (intent: Intent) => {
  const upstream = intent.dns.upstream;
  if (upstream.type !== "encrypted") return [];
  return [dohPorts.provider, ...(fallbackOf(upstream) ? [dohPorts.fallback] : [])];
};

export const readNetworkStatus = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  now?: () => number;
}): Promise<Result<NetworkStatus, Problem>> => {
  const loaded = await readStatusSettings(intentPath, platform);
  if (!loaded.ok) return loaded;
  const { intent, ready, expected, facts: known } = loaded.value;
  const devices = await readEach({
    intentPath,
    platform,
    devices: ready,
    facts: known,
    timeoutMs,
    now,
    read: (f) => {
      const { mustRun, shaped } = expected(f.hostname);
      const router = ready.find((d) => d.hostname === f.hostname)?.tags?.role === "router";
      // Where its mesh over cables runs: what locating just read it is (DSA or swconfig).
      const wired = meshWiredLink(f.schema);
      return readDeviceStatus(f.hostname, f.session, now, mustRun, {
        ...(router ? { internet: { shaped, doh: dohOf(intent) }, mdns: true } : {}),
        log: true,
        ...(wired ? { meshWired: wired } : {}),
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
    deviceViews: devicesOf(intent, devices, facts, (name) => expected(name).mustRun),
    radios: radiosOf(devices),
    ...(counters ? { internetCounters: counters } : {}),
    ...(check ? { internetCheck: check } : {}),
    reservations: intent.networks.flatMap((n) => n.dhcp.reservations.map((r) => r.mac.toLowerCase())),
  });
};
