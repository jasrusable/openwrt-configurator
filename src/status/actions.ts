// What a Status page can do when asked (and only then): restart a service the
// settings need running on a device (the fix for, say, odhcpd gone silent),
// reboot a device, restart its Wi-Fi, ping from it, test the internet line's
// download speed from the router, survey the air around the access points.
// Nothing here changes a setting.
import { z } from "zod";
import { readFacts } from "../deviceFacts";
import { Probe, runProbe } from "../deviceProbes";
import { getOpenWrtState } from "../engine/getOpenWrtState";
import { parseJson } from "../parseJson";
import { Platform } from "../platform";
import { fail, Problem, problem } from "../problem";
import { Result, attempt, messageOf, ok } from "../result";
import { read, stateLayout, StoreKey, tryWrite } from "../store";
import { loadSettings } from "../settings";
import { provisionableDevices } from "../apply/provisionConfig";
import { readEach } from "../readEach";
import { jobState } from "../server/provisionJob";
import { withLock } from "../lock";
import { shellQuote } from "../shell";
import { DeviceView, restartable } from "./views";
import { arr, bandOf, channelOf, obj } from "./values";

/**
 * One device, found and logged in to as anywhere else (src/locate.ts), within
 * a time limit; the session closed after. Refused while an apply runs: a
 * restart or a scan then could cut the link it confirms over, and roll it back.
 */
export const onDevice = async <T>(
  intentPath: string,
  platform: Platform,
  hostname: string,
  timeoutMs: number,
  work: (session: Parameters<typeof runProbe>[0], state: () => ReturnType<typeof getOpenWrtState>) => Promise<Result<T, Problem>>
): Promise<Result<T, Problem>> => {
  if ((await jobState({ intentPath, files: platform }).catch(() => undefined))?.state === "running") {
    return fail("conflict", "An apply is running: try again when it has finished.");
  }
  const loaded = await loadSettings(intentPath, platform);
  if (!loaded.ok) return loaded;
  const { ready } = provisionableDevices(loaded.value.plan);
  const deviceConfig = ready.find((d) => d.hostname === hostname);
  if (!deviceConfig) return fail("not-found", `${hostname} is not in Hardware.`);
  const facts = readFacts(platform, intentPath, [hostname]);
  const schema = facts[hostname]?.schema;
  if (!schema) return fail("conflict", `${hostname} has not been read yet.`);
  const [result] = await readEach({
    intentPath,
    platform,
    devices: [deviceConfig],
    facts,
    timeoutMs,
    read: (found) =>
      work(found.session, () => getOpenWrtState({ plan: loaded.value.plan, deviceConfig, deviceSchema: schema })),
  });
  return result.ok ? result.value : fail("unreachable", `${hostname}: ${result.error.message}`);
};

/**
 * One at a time, per action, across processes (a CGI request is one): a second
 * click while one runs is told so. A lock left by a process that died is
 * taken over after a minute: every action ends sooner, inside uhttpd's 60 s
 * CGI limit (`actionBudgetMs`).
 */
export const oneAtATime = async <T>(
  platform: Platform,
  intentPath: string,
  name: string,
  work: () => Promise<Result<T, Problem>>
): Promise<Result<T, Problem>> => {
  const result = await withLock(platform, stateLayout(intentPath).actionLock(name), 1, work);
  return result === "busy" ? fail("busy", "One is already running: wait for it to finish.") : result;
};

/** What an action may take in all: uhttpd ends a CGI request at 60 s. */
export const actionBudgetMs = 50_000;

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
    if (!(state().services ?? []).some((s) => s.name === service && restartable(s))) {
      return fail("invalid", `${service} is not a service this page restarts on ${hostname}.`);
    }
    const restarted = await runProbe(session, {
      command: `/etc/init.d/${shellQuote(service)} restart >/dev/null 2>&1; echo $?`,
      parse: ({ stdout }) => stdout.trim() === "0",
    } as Probe<boolean>);
    return restarted ? ok({ ok: true as const }) : fail("failed", `${service} did not restart on ${hostname}.`);
  });

/**
 * Started in the background, a moment after the answer: the command returns
 * (and the session closes cleanly) before what it starts cuts the link.
 * Dropbear does not end what a session leaves running.
 */
const detached = (command: string, said: string): Probe<boolean> => ({
  command: `(sleep 2; ${command}) </dev/null >/dev/null 2>&1 & echo ${said}`,
  parse: ({ stdout }) => stdout.includes(said),
});

/** When each device was asked to reboot, kept so status can say so until it answers again. */
const rebootKey = (intentPath: string): StoreKey<Record<string, number>> => ({
  path: stateLayout(intentPath).rebooting,
  schema: z.record(z.string(), z.number()),
  format: 1,
});

/** How long a reboot is expected to take at most: past it, a device that has not come back is just not reached. */
const rebootWindowMs = 10 * 60_000;

/**
 * Whether a device asked to reboot at `at` is still on its way: not answered
 * since, or answering with an uptime from before the request (it has not gone
 * down yet).
 */
export const stillRebooting = (at: number, device: Pick<DeviceView, "reachable" | "uptime"> | undefined, now: number) =>
  now - at < rebootWindowMs &&
  (!device?.reachable || device.uptime === undefined || device.uptime * 1000 > now - at);

/** The status with each device on its way through a reboot marked so. */
export const withRebooting = <S extends { deviceViews?: DeviceView[] }>(status: S, asked: Record<string, number>, now: number): S =>
  status.deviceViews
    ? {
        ...status,
        deviceViews: status.deviceViews.map((d) =>
          asked[d.name] !== undefined && stillRebooting(asked[d.name], d, now) ? { ...d, rebooting: true } : d
        ),
      }
    : status;

/** Devices asked to reboot, as kept. */
export const rebootsAsked = (platform: Pick<Platform, "readTextFile">, intentPath: string) =>
  read(platform, rebootKey(intentPath)) ?? {};

/** Reboot `hostname`: it drops off for a minute or so; status says "rebooting" until it answers again. */
export const rebootDevice = ({
  intentPath,
  platform,
  hostname,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  hostname: string;
  now?: () => number;
}) =>
  oneAtATime(platform, intentPath, "reboot", () =>
    onDevice(intentPath, platform, hostname, 20_000, async (session) => {
      if (!(await runProbe(session, detached("reboot", "ONC_REBOOTING")))) return fail("failed", `${hostname} did not start rebooting.`);
      const at = now();
      // Kept only for the "rebooting" words: a write that fails costs those, not the reboot.
      tryWrite(platform, rebootKey(intentPath), { ...rebootsAsked(platform, intentPath), [hostname]: at });
      return ok({ rebootingSince: at });
    })
  );

/** Restart `hostname`'s Wi-Fi: its clients (and a mesh link through it) drop and reconnect within a minute. */
export const restartWifi = ({ intentPath, platform, hostname }: { intentPath: string; platform: Platform; hostname: string }) =>
  oneAtATime(platform, intentPath, "wifi-restart", () =>
    onDevice(intentPath, platform, hostname, 20_000, async (session) => {
      const hasWifi = await runProbe(session, { command: "command -v wifi >/dev/null && echo ONC_WIFI", parse: ({ stdout }) => stdout.includes("ONC_WIFI") } as Probe<boolean>);
      if (!hasWifi) return fail("invalid", `${hostname} has no Wi-Fi.`);
      return (await runProbe(session, detached("wifi down; wifi up", "ONC_RESTARTING")))
        ? ok({ ok: true as const })
        : fail("failed", `${hostname} did not restart its Wi-Fi.`);
    })
  );

/** A ping's target: an address or a host name, never anything a shell or ping would read as more. */
export const pingTarget = /^[A-Za-z0-9][A-Za-z0-9.:-]{0,252}$/;

export type PingResult = { sent: number; received: number; averageMs?: number };

/** busybox ping's summary: "4 packets transmitted, 3 packets received, …" and "round-trip min/avg/max = a/b/c ms". */
export const parsePing = (stdout: string): PingResult | undefined => {
  const counts = /(\d+) packets transmitted, (\d+) packets received/.exec(stdout);
  if (!counts) return undefined;
  const average = /min\/avg\/max = [\d.]+\/([\d.]+)\//.exec(stdout);
  return { sent: Number(counts[1]), received: Number(counts[2]), ...(average ? { averageMs: Number(average[1]) } : {}) };
};

/** Ping `target` from `hostname`: four pings, two seconds each at most. */
export const pingFrom = ({ intentPath, platform, hostname, target }: { intentPath: string; platform: Platform; hostname: string; target: string }) =>
  pingTarget.test(target)
    ? oneAtATime(platform, intentPath, "ping", () =>
        onDevice(intentPath, platform, hostname, 20_000, async (session) => {
          const pinged = await runProbe(session, {
            command: `ping -c 4 -W 2 ${shellQuote(target)} 2>&1`,
            parse: ({ stdout }) => ({ result: parsePing(stdout), said: stdout.trim().split("\n").pop() ?? "" }),
          } as Probe<{ result?: PingResult; said: string }>);
          return pinged.result ? ok(pinged.result) : fail("failed", pinged.said || `No answer from ping on ${hostname}.`);
        })
      )
    : Promise.resolve(fail("invalid", "Give an address or a host name to ping."));

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
    const loaded = await loadSettings(intentPath, platform);
    if (!loaded.ok) return loaded;
    const router = provisionableDevices(loaded.value.plan).ready.find((d) => d.tags?.role === "router");
    if (!router) return fail("conflict", "There is no router in Hardware.");
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
      return mbps ? ok({ downMbps: mbps }) : fail("failed", "The speed test did not finish.");
    });
  });

export type Survey = {
  accessPoint: string;
  /**
   * Each channel the radios measured: how busy it was (anyone's traffic,
   * ours included), %; unknown where the counters cannot be right.
   */
  channels: { band: string; channel: number; busy?: number; ours: boolean }[];
  /**
   * Networks around, our own radios left out: for picking a quieter channel.
   * `impostor`: one of your network names from a radio that is none of yours.
   */
  neighbours: { ssid?: string; band: string; channel: number; signal: number; impostor?: boolean }[];
};

/** A scanned network's band: iwinfo's own where it says (6 GHz channels reuse low numbers), else by channel. */
const bandOfScan = (n: Record<string, unknown>, channel: number) => {
  const mhz = Number(n.mhz ?? n.frequency);
  if (mhz > 0) return bandOf(mhz)!;
  const band = Number(n.band);
  return band === 6 ? "6 GHz" : band === 5 ? "5 GHz" : band === 2 ? "2.4 GHz" : channel > 14 ? "5 GHz" : "2.4 GHz";
};

type Heard = Survey["neighbours"][number] & { bssid?: string };
export type SurveyRead = { accessPoint: string; own: string[]; channels: Survey["channels"]; heard: Heard[] };

/** The survey probe's array: each radio's ifname, its own BSSID, iwinfo scan and survey. */
/** Far past any uptime, in ms: a counter this large wrapped (mt7915/mt7981 underflow them after days: mt76#1135). */
const wrapped = 1e15;

/** Whether a channel's survey counters can be right: busy no more than the time measured, neither wrapped. */
const plausible = (active: number, busy: number) => busy <= active && active < wrapped && busy < wrapped;

export const parseSurvey = (accessPoint: string, value: unknown): SurveyRead => {
  const radios = arr(value).map(obj);
  const seen = new Map<number, Survey["channels"][number]>();
  const heard: Heard[] = [];
  for (const radio of radios) {
    for (const s of arr(obj(radio.survey).results).map(obj)) {
      const mhz = Number(s.mhz);
      const active = Number(s.active_time);
      const busy = Number(s.busy_time);
      if (!(mhz > 0) || !(active > 0) || !(busy >= 0)) continue;
      const entry = {
        band: bandOf(mhz)!,
        channel: channelOf(mhz),
        ...(plausible(active, busy) ? { busy: Math.round((busy / active) * 100) } : {}),
        ours: s.in_use === true,
      };
      if (!seen.has(mhz) || entry.ours) seen.set(mhz, entry);
    }
    for (const n of arr(obj(radio.scan).results).map(obj)) {
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
    const loaded = await loadSettings(intentPath, platform);
    if (!loaded.ok) return loaded;
    const { plan, intent } = loaded.value;
    const ssids = (intent?.wifi.networks ?? []).map((w) => w.ssid);
    const hosts = provisionableDevices(plan).ready.map((d) => d.hostname);
    const surveyed: SurveyRead[] = [];
    const failed: { accessPoint: string; error: string }[] = [];
    const deadline = Date.now() + actionBudgetMs;
    for (const hostname of hosts) {
      const left = deadline - Date.now();
      if (left < 5_000) {
        failed.push({ accessPoint: hostname, error: "No time was left to survey it: try again." });
        continue;
      }
      const result = await onDevice(intentPath, platform, hostname, Math.min(30_000, left), (session) =>
        attempt(
          () =>
            runProbe(session, {
              command: surveyCommand,
              parse: ({ stdout }) => parseSurvey(hostname, parseJson(stdout || "[]", "survey")),
            } as Probe<SurveyRead>),
          (e) => problem("failed", messageOf(e))
        )
      );
      if (result.ok) surveyed.push(result.value);
      else failed.push({ accessPoint: hostname, error: result.error.message });
    }
    return ok({
      surveys: neighboursOf(surveyed, ssids, failed.length === 0).filter((s) => s.channels.length > 0 || s.neighbours.length > 0),
      failed,
    });
  });
