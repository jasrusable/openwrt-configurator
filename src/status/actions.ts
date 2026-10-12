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
