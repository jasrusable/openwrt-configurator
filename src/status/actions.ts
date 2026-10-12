// What a Status tab can do when asked (and only then): restart a service the
// settings declare on a device (the fix for, say, odhcpd gone silent), test
// the internet line's download speed from the router, and look up OpenWrt's
// latest release. Nothing here changes a setting.
import { readFacts } from "../deviceFacts";
import { Probe, runProbe } from "../deviceProbes";
import { getOpenWrtState } from "../getOpenWrtState";
import { loadOncConfig } from "../loadConfig";
import { locateEach } from "../locate";
import { parseJson } from "../parseJson";
import { Platform } from "../platform";
import { provisionableDevices } from "../provisionConfig";
import { shellQuote } from "../shell";

/** One device, found and logged in to as anywhere else (src/locate.ts); the session closed after. */
const onDevice = async <T>(
  intentPath: string,
  platform: Platform,
  hostname: string,
  work: (session: Parameters<typeof runProbe>[0], state: ReturnType<typeof getOpenWrtState>) => Promise<T>
): Promise<T | { error: string }> => {
  const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
  const { ready } = provisionableDevices(oncConfig);
  const deviceConfig = ready.find((d) => d.hostname === hostname);
  if (!deviceConfig) return { error: `${hostname} is not in Hardware.` };
  const facts = readFacts(platform, intentPath, [hostname]);
  const schema = facts[hostname]?.schema;
  if (!schema) return { error: `${hostname} has not been read yet.` };
  const [found] = await Promise.all(locateEach({ devices: [deviceConfig], facts, platform }));
  if (!("session" in found)) return { error: `${hostname} could not be reached: ${found.error}` };
  try {
    return await work(found.session, getOpenWrtState({ oncConfig, deviceConfig, deviceSchema: schema }));
  } finally {
    found.session.dispose();
  }
};

/** Restart `service` on `hostname`: only one the settings declare there. */
export const restartService = ({
  intentPath,
  platform,
  hostname,
  service,
}: {
  intentPath: string;
  platform: Platform;
  hostname: string;
  service: string;
}) =>
  onDevice(intentPath, platform, hostname, async (session, state) => {
    if (!(state.services ?? []).some((s) => s.name === service)) {
      return { error: `${service} is not one of ${hostname}'s services in your settings.` };
    }
    const restarted = await runProbe(session, {
      command: `/etc/init.d/${shellQuote(service)} restart >/dev/null 2>&1; echo $?`,
      parse: ({ stdout }) => stdout.trim() === "0",
    } as Probe<boolean>);
    return restarted ? { ok: true as const } : { error: `${service} did not restart on ${hostname}.` };
  });

/** How long the router takes to download this much, from Cloudflare's speed test. */
const speedBytes = 25_000_000;

/** "<seconds> <bytes>" from the router: a download timed by its uptime clock (busybox has no time). */
export const parseSpeed = (stdout: string) => {
  const [seconds, bytes] = stdout.trim().split(/\s+/).map(Number);
  return seconds > 0 && bytes > 0 ? Math.round(((bytes * 8) / seconds / 1e6) * 10) / 10 : undefined;
};

/** The router's download speed now, Mbit/s: test traffic only, a few seconds. */
export const speedTest = async ({ intentPath, platform }: { intentPath: string; platform: Platform }) => {
  const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
  const router = provisionableDevices(oncConfig).ready.find((d) => d.tags?.role === "router");
  if (!router) return { error: "There is no router in Hardware." };
  return onDevice(intentPath, platform, router.hostname, async (session) => {
    const mbps = await runProbe(session, {
      command: [
        "a=$(cut -d' ' -f1 /proc/uptime)",
        `n=$(uclient-fetch -q -T 30 -O - 'https://speed.cloudflare.com/__down?bytes=${speedBytes}' 2>/dev/null | wc -c)`,
        "b=$(cut -d' ' -f1 /proc/uptime)",
        'echo "$(awk -v a="$a" -v b="$b" \'BEGIN { print b - a }\') $n"',
      ].join("; "),
      parse: ({ stdout }) => parseSpeed(stdout),
    } as Probe<number | undefined>);
    return mbps ? { downMbps: mbps } : { error: "The speed test did not finish." };
  });
};

/** OpenWrt's latest stable release, from its own downloads site; kept a day beside the intent. */
export const latestRelease = async ({ intentPath, platform }: { intentPath: string; platform: Platform }) => {
  const file = `${intentPath}.state/openwrt-release.json`;
  try {
    const kept = parseJson(platform.readTextFile(file), file) as { at: number; version: string };
    if (Date.now() - kept.at < 24 * 3600 * 1000 && typeof kept.version === "string") return { version: kept.version };
  } catch {
    // None kept yet.
  }
  try {
    const response = await platform.http.request({ method: "GET", url: "https://downloads.openwrt.org/.versions.json" });
    const version = (JSON.parse(response.body) as { stable_version?: unknown }).stable_version;
    if (typeof version !== "string") return { error: "openwrt.org did not say." };
    platform.mkdirp(`${intentPath}.state`);
    platform.writeTextFile(file, JSON.stringify({ at: Date.now(), version }));
    return { version };
  } catch (e) {
    return { error: `Could not ask openwrt.org: ${(e as Error).message}` };
  }
};

export type Survey = {
  accessPoint: string;
  /** Each channel the radios measured: how busy it was (anyone's traffic, ours included), %. */
  channels: { band: string; channel: number; busy: number; ours: boolean }[];
  /** Networks around, ours left out: for picking a quieter channel. */
  neighbours: { ssid?: string; band: string; channel: number; signal: number }[];
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown) => (Array.isArray(v) ? v : []);
const channelOf = (mhz: number) => (mhz === 2484 ? 14 : mhz < 2500 ? (mhz - 2407) / 5 : mhz >= 5955 ? (mhz - 5950) / 5 : (mhz - 5000) / 5);
const bandOfMhz = (mhz: number) => (mhz < 3000 ? "2.4 GHz" : mhz < 5925 ? "5 GHz" : "6 GHz");

/** The survey probe's array: each radio's ifname, iwinfo scan and survey. */
export const parseSurvey = (accessPoint: string, value: unknown, ours: string[]): Survey => {
  const radios = list(value).map(obj);
  const seen = new Map<string, Survey["channels"][number]>();
  const neighbours: Survey["neighbours"] = [];
  for (const radio of radios) {
    for (const s of list(obj(radio.survey).results).map(obj)) {
      const mhz = Number(s.mhz);
      const active = Number(s.active_time);
      const busy = Number(s.busy_time);
      if (!(mhz > 0) || !(active > 0) || !(busy >= 0)) continue;
      const key = `${mhz}`;
      const entry = { band: bandOfMhz(mhz), channel: channelOf(mhz), busy: Math.min(100, Math.round((busy / active) * 100)), ours: s.in_use === true };
      if (!seen.has(key) || entry.ours) seen.set(key, entry);
    }
    for (const n of list(obj(radio.scan).results).map(obj)) {
      const channel = Number(n.channel);
      const signal = Number(n.signal);
      const ssid = typeof n.ssid === "string" ? n.ssid : undefined;
      if (!(channel > 0) || !Number.isFinite(signal) || (ssid && ours.includes(ssid))) continue;
      neighbours.push({ ...(ssid ? { ssid } : {}), band: channel > 14 ? (channel > 177 || Number(n.band) === 6 ? "6 GHz" : "5 GHz") : "2.4 GHz", channel, signal });
    }
  }
  return {
    accessPoint,
    channels: [...seen.values()].sort((a, b) => a.channel - b.channel),
    neighbours: neighbours.sort((a, b) => b.signal - a.signal),
  };
};

/** Each access point's survey: on request only, as a scan can briefly disturb its clients. */
export const wifiSurvey = async ({ intentPath, platform }: { intentPath: string; platform: Platform }) => {
  const { oncConfig, intent } = await loadOncConfig({ path: intentPath, platform });
  const ours = (intent?.wifi ?? []).map((w) => w.ssid);
  const hosts = provisionableDevices(oncConfig).ready.map((d) => d.hostname);
  const command = [
    "printf '['; sep=''",
    "for o in $(ubus list 'hostapd.*' 2>/dev/null); do d=${o#hostapd.}",
    `  printf '%s{"ifname":"%s","scan":' "$sep" "$d"; ubus call iwinfo scan "{\\"device\\":\\"$d\\"}" 2>/dev/null || printf 'null'`,
    `  printf ',"survey":'; ubus call iwinfo survey "{\\"device\\":\\"$d\\"}" 2>/dev/null || printf 'null'`,
    "  printf '}'; sep=','",
    "done; printf ']'",
  ].join("\n");
  const surveys = await Promise.all(
    hosts.map((hostname) =>
      onDevice(intentPath, platform, hostname, async (session) =>
        runProbe(session, { command, parse: ({ stdout }) => parseSurvey(hostname, JSON.parse(stdout || "[]"), ours) } as Probe<Survey>)
      )
    )
  );
  return { surveys: surveys.filter((s): s is Survey => !("error" in s) && (s.channels.length > 0 || s.neighbours.length > 0)) };
};
