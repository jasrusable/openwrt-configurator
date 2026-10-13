// What OpenWrt has out, as ASU (the build server images come from) lists it:
// each series's stable releases, newest first. Asked at most once a day (the
// status collector asks when it is due, the Firmware tab when it opens) and
// kept beside the intent with when it was read, so offline the last answer
// stands, saying how old it is. Nothing here changes a device.
import { z } from "zod";
import { Platform } from "../platform";
import { compareReleases, isStableRelease, supportedRelease } from "../release";
import { attempt, messageOf } from "../result";
import { read, stateLayout, StoreKey, tryWrite } from "../store";
import type { Releases } from "./target";

export const asuOverviewUrl = "https://sysupgrade.openwrt.org/json/v1/overview.json";

/** How long an answer stands before it is asked again. */
export const releasesFreshMs = 24 * 3600 * 1000;

const releasesKey = (intentPath: string): StoreKey<Releases> => ({
  path: stateLayout(intentPath).releases,
  schema: z.object({ at: z.number(), series: z.record(z.string(), z.array(z.string())) }),
  format: 1,
});

const overviewSchema = z.object({
  branches: z.record(
    z.string(),
    z.object({ versions: z.array(z.string()).default([]), enabled: z.boolean().default(true), snapshot: z.boolean().default(false) })
  ),
});

/** ASU's overview, as the series this app can run and their stable releases, newest first; undefined when it is not one. */
export const parseOverview = (body: string, at: number): Releases | undefined => {
  const parsed = (() => {
    try {
      return overviewSchema.safeParse(JSON.parse(body));
    } catch {
      return undefined;
    }
  })();
  if (!parsed?.success) return undefined;
  const series = Object.entries(parsed.data.branches)
    .filter(([name, branch]) => branch.enabled && !branch.snapshot && supportedRelease(name))
    .map(([name, branch]) => [name, branch.versions.filter(isStableRelease).sort((a, b) => compareReleases(b, a) ?? 0)] as const)
    .filter(([, versions]) => versions.length > 0);
  return { at, series: Object.fromEntries(series) };
};

/** What is kept, however old. */
export const keptReleases = (files: Pick<Platform, "readTextFile">, intentPath: string) => read(files, releasesKey(intentPath));

/**
 * The releases, asked again when the kept answer is older than `maxAgeMs`
 * (or there is none). A failed ask keeps the last answer and says why.
 */
export const readReleases = async ({
  intentPath,
  platform,
  now = Date.now,
  maxAgeMs = releasesFreshMs,
}: {
  intentPath: string;
  platform: Pick<Platform, "readTextFile" | "writeFileAtomic" | "mkdirp" | "removeFile" | "http">;
  now?: () => number;
  maxAgeMs?: number;
}): Promise<{ releases?: Releases; error?: string }> => {
  const kept = keptReleases(platform, intentPath);
  if (kept && now() - kept.at < maxAgeMs) return { releases: kept };
  const asked = await attempt(
    () => platform.http.request({ method: "GET", url: asuOverviewUrl }),
    (e) => `Could not ask OpenWrt: ${messageOf(e)}`
  );
  const releases = asked.ok
    ? asked.value.status === 200
      ? parseOverview(asked.value.body, now())
      : undefined
    : undefined;
  if (!releases) {
    const error = asked.ok ? `OpenWrt's build server answered ${asked.value.status} with no releases.` : asked.error;
    return { ...(kept ? { releases: kept } : {}), error };
  }
  // Only so it is asked once a day: a write that fails asks again next time.
  tryWrite(platform, releasesKey(intentPath), releases);
  return { releases };
};
