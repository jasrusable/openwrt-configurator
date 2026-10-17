// Firmware images with the config built in: `build-images`, and
// `verify-images` against their manifest. The work is src/images.ts; this
// only prints.
import { CommandSpec } from "../args";
import { getDeviceBuildPlan } from "../getBuildPlan";
import { buildImages, groupPlans, imageFilename, manifestTable, profileOrGuess, verifyImages } from "../images";
import { loadConfigOrThrow } from "../loadConfig";
import { redactValue } from "../secrets";
import { CliContext } from "./context";
import { buildAll, imagePlans } from "../firmware/builds";
import { readFacts } from "../deviceFacts";
import { readReleases } from "../firmware/releases";
import { targetOf } from "../firmware/target";
import { appPublicKey } from "../loginAccess";
import type { Intent } from "../intent/schema";
import type { Plan } from "../plan/types";
import type { Platform } from "../platform";

export const buildImagesCommand = ({ platform }: CliContext): CommandSpec => ({
  name: "build-images",
  description:
    "build per-device sysupgrade images via the OpenWrt firmware-selector API, pre-loaded with package profiles and a UCI-defaults bootstrap script",
  args: [
    { name: "config-file", description: "config file to build images for" },
  ],
  options: [
    {
      flags: "--out <dir>",
      description: "output directory for built images",
      default: "./images",
    },
    {
      flags: "--dry-run",
      description:
        "print the resolved build payload (including UCI-defaults script) without submitting",
    },
    {
      flags: "--concurrency <n>",
      description: "max concurrent ASU builds",
      parse: (v) => parseInt(v, 10),
      default: 3,
    },
    {
      flags: "--show-secrets",
      description:
        "print resolved secret values in --dry-run output (default: redact)",
    },
  ],
  action: async ([configPath], options) => {
    const { plan: config, secrets, intent } = await loadConfigOrThrow({ path: configPath, platform });
    if (intent) return intentImages({ intentPath: configPath, intent, plan: config, dryRun: !!options.dryRun, concurrency: options.concurrency || 3, platform });
    const plans = config.devices
      .filter((device) => device.enabled !== false)
      .map((deviceConfig) => getDeviceBuildPlan({ plan: config, deviceConfig }));
    const groups = groupPlans(plans, platform.sha256);

    if (options.dryRun) {
      for (const [hash, group] of groups) {
        const plan = group[0];
        const { target, profile } = await profileOrGuess(plan, platform);
        const hostnames = group.map((p) => p.deviceConfig.hostname);
        console.log(`# image ${imageFilename(plan, hash)} (${group.length} device${group.length === 1 ? "" : "s"}: ${hostnames.join(", ")})`);
        console.log(JSON.stringify({ version: plan.version, target, profile, packages: plan.packages }, null, 2));
        console.log("# --- UCI defaults script ---");
        console.log(
          options.showSecrets
            ? plan.uciDefaults
            : getDeviceBuildPlan({ plan: config, deviceConfig: plan.deviceConfig, redact: (value) => redactValue(value, secrets) }).uciDefaults
        );
        console.log("# --- end ---\n");
      }
      return;
    }

    const { manifest, manifestPath, failures } = await buildImages({
      groups,
      outDir: options.out,
      concurrency: options.concurrency || 3,
      platform,
      log: (line) => console.log(line),
      logError: (line) => console.error(line),
    });
    console.log(`\nmanifest written to ${manifestPath}`);
    const table = manifestTable(manifest);
    if (table.length > 0) console.log(`\n${table.join("\n")}`);
    const devices = manifest.reduce((n, m) => n + m.devices.length, 0);
    console.log(`\nbuilt ${manifest.length} image${manifest.length === 1 ? "" : "s"} for ${devices} device${devices === 1 ? "" : "s"}`);
    if (failures.length > 0) {
      console.error(`\n${failures.length} group${failures.length === 1 ? "" : "s"} failed:`);
      for (const f of failures) console.error(`  ${f.model_id} ${f.hash} (${f.hostnames.join(", ")}): ${f.error}`);
      platform.exit(1);
    }
  },
});

export const verifyImagesCommand = ({ platform }: CliContext): CommandSpec => ({
  name: "verify-images",
  description:
    "verify built images against manifest.json by recomputing sha256",
  options: [
    {
      flags: "--out <dir>",
      description: "directory containing built images and manifest.json",
      default: "./images",
    },
  ],
  action: async (_args, options) => {
    const { results, total, failed } = await verifyImages(options.out, platform);
    results.forEach((r) => console.log(r.line));
    if (failed > 0) {
      console.log(`\n${failed} of ${total} image(s) failed verification`);
      platform.exit(1);
    }
    console.log(`\nall ${total} image(s) verified`);
  },
});

/**
 * An intent's images: each device's at the release its settings give it
 * (held ones left out), from its stored facts, one build per board, role and
 * release (src/firmware/builds.ts), kept beside the intent. Nothing secret
 * is in them, so the dry run prints them whole.
 */
const intentImages = async ({
  intentPath,
  intent,
  plan,
  dryRun,
  concurrency,
  platform,
}: {
  intentPath: string;
  intent: Intent;
  plan: Plan;
  dryRun: boolean;
  concurrency: number;
  platform: Platform;
}) => {
  const { releases } = await readReleases({ intentPath, platform });
  const facts = readFacts(platform, intentPath, intent.hardware.map((d) => d.name));
  const versions = Object.fromEntries(
    intent.hardware.flatMap(({ name }) => {
      const target = targetOf(intent, name, releases);
      return target.kind === "release" ? [[name, target.version]] : [];
    })
  );
  const { images, unbuildable } = imagePlans({
    intent,
    plan,
    facts: Object.fromEntries(Object.entries(facts).map(([name, f]) => [name, f?.schema])),
    versions,
    sha256: platform.sha256,
    appKey: await appPublicKey(intent, platform),
  });
  unbuildable.forEach((u) => console.error(`${u.device}: ${u.why}`));
  if (dryRun) {
    for (const image of images) {
      console.log(`# image ${image.hash} (${image.devices.join(", ")})`);
      console.log(JSON.stringify({ version: image.version, target: image.target, board: image.board, packages: image.packages }, null, 2));
      console.log(`# --- first-boot script ---\n${image.defaults}# --- end ---\n`);
    }
    return;
  }
  const built = await buildAll({ intentPath, images, platform, concurrency, log: (line) => console.log(line) });
  built.forEach((b) => console.log("built" in b ? `${b.image.devices.join(", ")}: ${b.built.path}` : `${b.image.devices.join(", ")}: FAILED ${b.error}`));
  if (unbuildable.length || built.some((b) => "error" in b)) platform.exit(1);
};
