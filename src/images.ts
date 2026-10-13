// Building firmware images for a whole config (OpenWrt's firmware selector,
// src/buildImage.ts for the requests): devices that would get the same image
// share one build, each build is downloaded and checked, and the manifest
// says which image is whose. The CLI (src/cli/images.ts) only prints.
import {
  downloadImage,
  getProfileTarget,
  pickSysupgradeImage,
  pollBuild,
  requestBuild,
  verifyImageFile,
} from "./buildImage";
import { DeviceBuildPlan } from "./getBuildPlan";
import { join } from "./posixPath";
import { Platform } from "./platform";
import { messageOf } from "./result";

export type ManifestEntry = {
  filename: string;
  model_id: string;
  version: string;
  sha256: string;
  devices: { hostname: string; tags: Record<string, unknown> }[];
};

export type BuildFailure = { hash: string; model_id: string; hostnames: string[]; error: string };

/** Plans that would build the same image, by a short hash of what goes into it. */
export const groupPlans = (plans: DeviceBuildPlan[], sha256: (text: string) => string): Map<string, DeviceBuildPlan[]> =>
  plans.reduce((groups, plan) => {
    const key = sha256(
      JSON.stringify({
        version: plan.version,
        model_id: plan.deviceConfig.modelId,
        packages: [...plan.packages].sort(),
        uciDefaults: plan.uciDefaults,
      })
    ).slice(0, 12);
    return groups.set(key, [...(groups.get(key) ?? []), plan]);
  }, new Map<string, DeviceBuildPlan[]>());

export const imageFilename = (plan: DeviceBuildPlan, hash: string) =>
  `${plan.deviceConfig.modelId.replace(",", "_")}-${plan.version}-${hash}.bin`;

/** The firmware selector's target and profile for a plan, or placeholders when it cannot be asked (a dry run offline). */
export const profileOrGuess = async (plan: DeviceBuildPlan, platform: Platform) => {
  try {
    return await getProfileTarget({ version: plan.version, modelId: plan.deviceConfig.modelId, platform });
  } catch {
    return { target: "<unresolved (network unavailable)>", profile: plan.deviceConfig.modelId.replace(",", "_") };
  }
};

/** Build one group's image, download it to `outDir` and check it: its manifest entry. */
const buildGroup = async (
  hash: string,
  group: DeviceBuildPlan[],
  { outDir, platform, log }: { outDir: string; platform: Platform; log: (line: string) => void }
): Promise<ManifestEntry> => {
  const plan = group[0];
  const tag = `${plan.deviceConfig.modelId} ${hash}`;
  log(`[${tag}] resolving profile for ${plan.version}...`);
  const { profile, target } = await getProfileTarget({ version: plan.version, modelId: plan.deviceConfig.modelId, platform });
  log(`[${tag}] requesting build (${target}/${profile})...`);
  const { requestHash } = await requestBuild({
    req: { version: plan.version, target, profile, packages: plan.packages, defaults: plan.uciDefaults },
    platform,
  });
  log(`[${tag}] build queued: ${requestHash}`);
  const result = await pollBuild({ requestHash, platform });
  const sysupgrade = pickSysupgradeImage(result);
  const filename = imageFilename(plan, hash);
  const outPath = join(outDir, filename);
  log(`[${tag}] downloading ${sysupgrade.name} -> ${outPath}`);
  const verified = await downloadImage({
    binDir: result.bin_dir,
    name: sysupgrade.name,
    outPath,
    expectedSha256: sysupgrade.sha256,
    expectedSize: sysupgrade.size,
    platform,
  });
  log(`[${tag}] verified. sha256=${verified.sha256} size=${verified.size} format=${verified.magic}`);
  return {
    filename,
    model_id: plan.deviceConfig.modelId,
    version: plan.version,
    sha256: sysupgrade.sha256,
    devices: group.map((p) => ({ hostname: p.deviceConfig.hostname, tags: p.deviceConfig.tags || {} })),
  };
};

/**
 * Build every group, `concurrency` at a time, and write the manifest: what
 * was built (sorted by file name) and what failed, each failure said as it happens.
 */
export const buildImages = async ({
  groups,
  outDir,
  concurrency,
  platform,
  log,
  logError,
}: {
  groups: Map<string, DeviceBuildPlan[]>;
  outDir: string;
  concurrency: number;
  platform: Platform;
  log: (line: string) => void;
  logError: (line: string) => void;
}) => {
  platform.mkdirp(outDir);
  const queue = [...groups];
  const built: ManifestEntry[] = [];
  const failures: BuildFailure[] = [];
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const [hash, group] = next;
      try {
        built.push(await buildGroup(hash, group, { outDir, platform, log }));
      } catch (e) {
        const plan = group[0];
        const error = messageOf(e);
        logError(`[${plan.deviceConfig.modelId} ${hash}] FAILED: ${error}`);
        failures.push({ hash, model_id: plan.deviceConfig.modelId, hostnames: group.map((p) => p.deviceConfig.hostname), error });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, worker));
  const manifest = [...built].sort((a, b) => a.filename.localeCompare(b.filename));
  const manifestPath = join(outDir, "manifest.json");
  platform.writeTextFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, manifestPath, failures };
};

/** Which device gets which image, as an aligned table (empty when none was built). */
export const manifestTable = (manifest: ManifestEntry[]): string[] => {
  const rows = manifest
    .flatMap((m) => m.devices.map((d) => ({ hostname: d.hostname, model: m.model_id, version: m.version, image: m.filename })))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
  if (rows.length === 0) return [];
  const columns = ["hostname", "model", "version", "image"] as const;
  const widths = Object.fromEntries(columns.map((c) => [c, Math.max(c.length, ...rows.map((r) => r[c].length))])) as Record<
    (typeof columns)[number],
    number
  >;
  const line = (cell: (c: (typeof columns)[number]) => string) => columns.map((c) => cell(c).padEnd(widths[c])).join("  ");
  return [line((c) => c), line((c) => "-".repeat(widths[c])), ...rows.map((r) => line((c) => r[c]))];
};

/** Each built image checked against the manifest's sha256, in its order. */
export const verifyImages = async (outDir: string, platform: Pick<Platform, "readTextFile" | "sha256File">) => {
  const manifest = JSON.parse(platform.readTextFile(join(outDir, "manifest.json"))) as ManifestEntry[];
  const results = await Promise.all(
    manifest.map(async (entry) => {
      const hostnames = entry.devices.map((d) => d.hostname).join(", ");
      try {
        const { ok, actualSha256 } = await verifyImageFile({ path: join(outDir, entry.filename), expectedSha256: entry.sha256, platform });
        return ok
          ? { ok: true, line: `OK    ${entry.filename} (${hostnames})` }
          : { ok: false, line: `FAIL  ${entry.filename} (${hostnames}): expected ${entry.sha256}, got ${actualSha256}` };
      } catch (e) {
        return { ok: false, line: `ERROR ${entry.filename}: ${messageOf(e)}` };
      }
    })
  );
  return { results, total: manifest.length, failed: results.filter((r) => !r.ok).length };
};
