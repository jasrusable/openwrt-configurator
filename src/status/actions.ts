// What a Status page can do when asked (and only then): restart a service the
// settings need running on a device (the fix for, say, odhcpd gone silent),
// test the internet line's download speed from the router, survey the air
// around the access points, and look up OpenWrt's latest release. Nothing here
// changes a setting.
import { readFacts } from "../deviceFacts";
import { Probe, runProbe } from "../deviceProbes";
import { getOpenWrtState } from "../getOpenWrtState";
import { loadOncConfig } from "../loadConfig";
import { parseJson } from "../parseJson";
import { Platform } from "../platform";
import { provisionableDevices } from "../provisionConfig";
import { readEach } from "../readEach";
import { provisionStatus } from "../server/provisionJob";
import { shellQuote } from "../shell";
import { restartable } from "./views";

/**
 * One device, found and logged in to as anywhere else (src/locate.ts), within
 * a time limit; the session closed after. Refused while an apply runs: a
 * restart or a scan then could cut the link it confirms over, and roll it back.
 */
const onDevice = async <T>(
  intentPath: string,
  platform: Platform,
  hostname: string,
  timeoutMs: number,
  work: (session: Parameters<typeof runProbe>[0], state: ReturnType<typeof getOpenWrtState>) => Promise<T>
): Promise<T | { error: string }> => {
  if ((await provisionStatus({ intentPath, files: platform }).catch(() => undefined))?.state === "running") {
    return { error: "An apply is running: try again when it has finished." };
  }
  const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
  const { ready } = provisionableDevices(oncConfig);
  const deviceConfig = ready.find((d) => d.hostname === hostname);
  if (!deviceConfig) return { error: `${hostname} is not in Hardware.` };
  const facts = readFacts(platform, intentPath, [hostname]);
  const schema = facts[hostname]?.schema;
  if (!schema) return { error: `${hostname} has not been read yet.` };
  const [result] = await readEach<T | { error: string }>({
    intentPath,
    platform,
    devices: [deviceConfig],
    facts,
    timeoutMs,
    read: (found) => work(found.session, getOpenWrtState({ oncConfig, deviceConfig, deviceSchema: schema })),
    failed: (_, error) => ({ error: `${hostname}: ${error}` }),
  });
  return result;
};

/**
 * One at a time, per action, across processes (a CGI request is one): a second
 * click while one runs is told so. A lock left by a process that died is
 * taken over after two minutes, longer than any action takes.
 */
const oneAtATime = async <T>(
  platform: Platform,
  intentPath: string,
  name: string,
  work: () => Promise<T | { error: string }>
): Promise<T | { error: string }> => {
  platform.mkdirp(`${intentPath}.state`);
  const lock = `${intentPath}.state/${name}.lock`;
  const q = shellQuote(lock);
  const taken = await platform.run(["sh", "-c", `mkdir ${q} 2>/dev/null || { find ${q} -prune -mmin +2 | grep -q . && touch ${q}; }`]);
  if (taken.code !== 0) return { error: "One is already running: wait for it to finish." };
  try {
    return await work();
  } finally {
    await platform.run(["rmdir", lock]).catch(() => undefined);
  }
};

/** Restart `service` on `hostname`: only one the settings need running there, and never what the link itself depends on. */
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
  onDevice(intentPath, platform, hostname, 20_000, async (session, state) => {
    if (!(state.services ?? []).some((s) => s.name === service && restartable(s))) {
      return { error: `${service} is not a service this page restarts on ${hostname}.` };
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

/** The router's download speed now, Mbit/s: test traffic only (25 MB), a few seconds, one at a time. */
export const speedTest = ({ intentPath, platform }: { intentPath: string; platform: Platform }) =>
  oneAtATime(platform, intentPath, "speed-test", async () => {
    const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
    const router = provisionableDevices(oncConfig).ready.find((d) => d.tags?.role === "router");
    if (!router) return { error: "There is no router in Hardware." };
    return onDevice(intentPath, platform, router.hostname, 45_000, async (session) => {
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
  });

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
    platform.writeFileAtomic(file, JSON.stringify({ at: Date.now(), version }), 0o644);
    return { version };
  } catch (e) {
    return { error: `Could not ask openwrt.org: ${(e as Error).message}` };
  }
};

export type Survey = {
  accessPoint: string;
  /** Each channel the radios measured: how busy it was (anyone's traffic, ours included), %. */
  channels: { band: string; channel: number; busy: number; ours: boolean }[];
  /**
   * Networks around, our own radios left out: for picking a quieter channel.
   * `impostor`: one of your network names from a radio that is none of yours.
   */
  neighbours: { ssid?: string; band: string; channel: number; signal: number; impostor?: boolean }[];
};

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const list = (v: unknown) => (Array.isArray(v) ? v : []);
const channelOf = (mhz: number) => (mhz === 2484 ? 14 : mhz < 2500 ? (mhz - 2407) / 5 : mhz >= 5955 ? (mhz - 5950) / 5 : (mhz - 5000) / 5);
const bandOfMhz = (mhz: number) => (mhz < 3000 ? "2.4 GHz" : mhz < 5925 ? "5 GHz" : "6 GHz");
/** A scanned network's band: iwinfo's own where it says (6 GHz channels reuse low numbers), else by channel. */
const bandOfScan = (n: Record<string, unknown>, channel: number) => {
  const mhz = Number(n.mhz ?? n.frequency);
  if (mhz > 0) return bandOfMhz(mhz);
  const band = Number(n.band);
  return band === 6 ? "6 GHz" : band === 5 ? "5 GHz" : band === 2 ? "2.4 GHz" : channel > 14 ? "5 GHz" : "2.4 GHz";
};

type Heard = Survey["neighbours"][number] & { bssid?: string };
export type SurveyRead = { accessPoint: string; own: string[]; channels: Survey["channels"]; heard: Heard[] };

/** The survey probe's array: each radio's ifname, its own BSSID, iwinfo scan and survey. */
export const parseSurvey = (accessPoint: string, value: unknown): SurveyRead => {
  const radios = list(value).map(obj);
  const seen = new Map<number, Survey["channels"][number]>();
  const heard: Heard[] = [];
  for (const radio of radios) {
    for (const s of list(obj(radio.survey).results).map(obj)) {
      const mhz = Number(s.mhz);
      const active = Number(s.active_time);
      const busy = Number(s.busy_time);
      if (!(mhz > 0) || !(active > 0) || !(busy >= 0)) continue;
      const entry = { band: bandOfMhz(mhz), channel: channelOf(mhz), busy: Math.min(100, Math.round((busy / active) * 100)), ours: s.in_use === true };
      if (!seen.has(mhz) || entry.ours) seen.set(mhz, entry);
    }
    for (const n of list(obj(radio.scan).results).map(obj)) {
      const channel = Number(n.channel);
      const signal = Number(n.signal);
      if (!(channel > 0) || !Number.isFinite(signal)) continue;
      heard.push({
        ...(typeof n.ssid === "string" && n.ssid ? { ssid: n.ssid } : {}),
        ...(typeof n.bssid === "string" ? { bssid: n.bssid.toLowerCase() } : {}),
        band: bandOfScan(n, channel),
        channel,
        signal,
      });
    }
  }
  return {
    accessPoint,
    own: radios.flatMap((r) => (typeof r.bssid === "string" && r.bssid ? [r.bssid.toLowerCase()] : [])),
    channels: [...seen.values()].sort((a, b) => a.channel - b.channel),
    heard,
  };
};

/**
 * Every survey's neighbours, our own radios (any access point's) left out by
 * BSSID. A network with one of our names from another radio is kept and
 * marked: that is what an impostor looks like. When an access point could not
 * be surveyed its radios are unknown, so networks with our names are left out
 * rather than wrongly called impostors.
 */
export const neighboursOf = (surveys: SurveyRead[], ssids: string[], complete: boolean): Survey[] => {
  const own = new Set(surveys.flatMap((s) => s.own));
  const ourName = (n: Heard) => !!n.ssid && ssids.includes(n.ssid);
  return surveys.map(({ accessPoint, channels, heard }) => ({
    accessPoint,
    channels,
    neighbours: heard
      .filter((n) => !(n.bssid && own.has(n.bssid)) && (complete || !ourName(n)))
      .map(({ bssid: _, ...n }) => (ourName(n) ? { ...n, impostor: true } : n))
      .sort((a, b) => Number(!!b.impostor) - Number(!!a.impostor) || b.signal - a.signal),
  }));
};

  // Each call captured first, so one failing partway cannot leave half its JSON.
  export const surveyCommand = [
    'call() { r=$(ubus call "$@" 2>/dev/null) && [ -n "$r" ] && printf \'%s\' "$r" || printf null; }',
    "printf '['; sep=''",
    "for o in $(ubus list 'hostapd.*' 2>/dev/null); do d=${o#hostapd.}",
    `  printf '%s{"ifname":"%s","bssid":"%s","scan":' "$sep" "$d" "$(cat /sys/class/net/$d/address 2>/dev/null)"; call iwinfo scan "{\\"device\\":\\"$d\\"}"`,
    `  printf ',"survey":'; call iwinfo survey "{\\"device\\":\\"$d\\"}"`,
    "  printf '}'; sep=','",
    "done; printf ']'",
  ].join("\n");

/**
 * Each access point's survey: on request only, one access point at a time, as
 * a scan briefly takes its radios off their channel and its clients may notice.
 */
export const wifiSurvey = ({ intentPath, platform }: { intentPath: string; platform: Platform }) =>
  oneAtATime(platform, intentPath, "survey", async () => {
    const { oncConfig, intent } = await loadOncConfig({ path: intentPath, platform });
    const ssids = (intent?.wifi.networks ?? []).map((w) => w.ssid);
    const hosts = provisionableDevices(oncConfig).ready.map((d) => d.hostname);
    const read: SurveyRead[] = [];
    const failed: { accessPoint: string; error: string }[] = [];
    for (const hostname of hosts) {
      const result = await onDevice(intentPath, platform, hostname, 30_000, (session) =>
        runProbe(session, { command: surveyCommand, parse: ({ stdout }) => parseSurvey(hostname, parseJson(stdout || "[]", "survey")) } as Probe<SurveyRead>)
      ).catch((e: Error) => ({ error: e.message }));
      if ("error" in result) failed.push({ accessPoint: hostname, error: result.error });
      else read.push(result);
    }
    return {
      surveys: neighboursOf(read, ssids, failed.length === 0).filter((s) => s.channels.length > 0 || s.neighbours.length > 0),
      failed,
    };
  });
