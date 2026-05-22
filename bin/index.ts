import { createHash } from "crypto";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { DeviceBuildPlan } from "../src/getBuildPlan";
import { ONCConfig, oncConfigSchema } from "../src/oncConfigSchema";
import { getDeviceScript } from "../src/getDeviceScript";
import { program } from "commander";
import { provisionConfig } from "../src/provisionConfig";
import { getDeviceSchema } from "../src/getDeviceSchema";
import { parseJson, parseSchema } from "../src/utils";
import { getOpenWrtState } from "../src/getOpenWrtState";
import { getDeviceBuildPlan } from "../src/getBuildPlan";
import {
  downloadImage,
  getProfileTarget,
  pickSysupgradeImage,
  pollBuild,
  requestBuild,
  verifyImageFile,
} from "../src/buildImage";

export const main = async () => {
  program
    .name("openwrt-configurator")
    .description("OpenWrt Configurator")
    .version("0.0.1");

  program
    .command("provision")
    .description("provision configuration to devices")
    .argument("<config-file>", "config file to provision")
    .action(async (configPath) => {
      const oncConfigString = readFileSync(configPath, "utf-8");
      const oncJson = parseJson(oncConfigString, configPath);
      const oncConfig: ONCConfig = parseSchema(oncConfigSchema, oncJson);
      await provisionConfig({ oncConfig });
    });

  program
    .command("print-uci-commands")
    .description("print uci commands for configuration")
    .argument("<config-file>", "config file to print uci commands for")
    .action(async (configPath) => {
      const oncConfigString = readFileSync(configPath, "utf-8");
      const oncJson = parseJson(oncConfigString, configPath);
      const oncConfig: ONCConfig = parseSchema(oncConfigSchema, oncJson);
      const deviceConfigs = oncConfig.devices.filter(
        (device) => device.enabled !== false
      );

      const deviceSchemas = await Promise.all(
        deviceConfigs.map(async (deviceConfig) => {
          const deviceSchema = await getDeviceSchema({ deviceConfig });
          return deviceSchema;
        })
      );

      for (const deviceConfig of deviceConfigs) {
        const deviceSchema = deviceSchemas.find(
          (schema) => schema.name === deviceConfig.model_id
        );
        if (!deviceSchema) {
          throw new Error(
            `Device schema not found for device model: ${deviceConfig.model_id}`
          );
        }
        const state = getOpenWrtState({
          oncConfig: oncConfig,
          deviceConfig,
          deviceSchema,
        });

        const commands = await getDeviceScript({ state });
        console.log(`#device ${deviceConfig.hostname}`);
        console.log(commands.join("\n"));
      }
    });

  program
    .command("build-images")
    .description(
      "build per-device sysupgrade images via the OpenWrt firmware-selector API, pre-loaded with package profiles and a UCI-defaults bootstrap script"
    )
    .argument("<config-file>", "config file to build images for")
    .option("--out <dir>", "output directory for built images", "./images")
    .option(
      "--dry-run",
      "print the resolved build payload (including UCI-defaults script) without submitting"
    )
    .option(
      "--concurrency <n>",
      "max concurrent ASU builds",
      (v) => parseInt(v, 10),
      3
    )
    .action(async (configPath, options) => {
      const oncConfigString = readFileSync(configPath, "utf-8");
      const oncJson = parseJson(oncConfigString, configPath);
      const oncConfig: ONCConfig = parseSchema(oncConfigSchema, oncJson);
      const deviceConfigs = oncConfig.devices.filter(
        (device) => device.enabled !== false
      );

      const plans = deviceConfigs.map((deviceConfig) =>
        getDeviceBuildPlan({ oncConfig, deviceConfig })
      );

      const groupKey = (plan: DeviceBuildPlan) =>
        createHash("sha256")
          .update(
            JSON.stringify({
              version: plan.version,
              model_id: plan.deviceConfig.model_id,
              packages: [...plan.packages].sort(),
              uciDefaults: plan.uciDefaults,
            })
          )
          .digest("hex")
          .slice(0, 12);

      const groups = new Map<string, DeviceBuildPlan[]>();
      for (const plan of plans) {
        const key = groupKey(plan);
        const existing = groups.get(key);
        if (existing) {
          existing.push(plan);
        } else {
          groups.set(key, [plan]);
        }
      }

      const imageFilename = (plan: DeviceBuildPlan, hash: string) =>
        `${plan.deviceConfig.model_id.replace(",", "_")}-${plan.version}-${hash}.bin`;

      if (options.dryRun) {
        for (const [hash, group] of groups) {
          const plan = group[0];
          let target: string | undefined;
          let profile: string | undefined;
          try {
            const resolved = await getProfileTarget({
              version: plan.version,
              modelId: plan.deviceConfig.model_id,
            });
            target = resolved.target;
            profile = resolved.profile;
          } catch (e) {
            target = "<unresolved (network unavailable)>";
            profile = plan.deviceConfig.model_id.replace(",", "_");
          }
          const hostnames = group.map((p) => p.deviceConfig.hostname);
          console.log(
            `# image ${imageFilename(plan, hash)} (${group.length} device${
              group.length === 1 ? "" : "s"
            }: ${hostnames.join(", ")})`
          );
          console.log(
            JSON.stringify(
              {
                version: plan.version,
                target,
                profile,
                packages: plan.packages,
              },
              null,
              2
            )
          );
          console.log("# --- UCI defaults script ---");
          console.log(plan.uciDefaults);
          console.log("# --- end ---\n");
        }
        return;
      }

      mkdirSync(options.out, { recursive: true });

      type ManifestEntry = {
        filename: string;
        model_id: string;
        version: string;
        sha256: string;
        devices: { hostname: string; tags: Record<string, unknown> }[];
      };
      type Failure = {
        hash: string;
        model_id: string;
        hostnames: string[];
        error: string;
      };
      const manifest: ManifestEntry[] = [];
      const failures: Failure[] = [];

      const buildGroup = async (hash: string, group: DeviceBuildPlan[]) => {
        const plan = group[0];
        const tag = `${plan.deviceConfig.model_id} ${hash}`;
        console.log(`[${tag}] resolving profile for ${plan.version}...`);
        const { profile, target } = await getProfileTarget({
          version: plan.version,
          modelId: plan.deviceConfig.model_id,
        });
        console.log(`[${tag}] requesting build (${target}/${profile})...`);
        const { requestHash } = await requestBuild({
          version: plan.version,
          target,
          profile,
          packages: plan.packages,
          defaults: plan.uciDefaults,
        });
        console.log(`[${tag}] build queued: ${requestHash}`);
        const result = await pollBuild({ requestHash });
        const sysupgrade = pickSysupgradeImage(result);
        const filename = imageFilename(plan, hash);
        const outPath = join(options.out, filename);
        console.log(`[${tag}] downloading ${sysupgrade.name} -> ${outPath}`);
        const verified = await downloadImage({
          binDir: result.bin_dir,
          name: sysupgrade.name,
          outPath,
          expectedSha256: sysupgrade.sha256,
          expectedSize: sysupgrade.size,
        });
        console.log(
          `[${tag}] verified. sha256=${verified.sha256} size=${verified.size} format=${verified.magic}`
        );
        manifest.push({
          filename,
          model_id: plan.deviceConfig.model_id,
          version: plan.version,
          sha256: sysupgrade.sha256,
          devices: group.map((p) => ({
            hostname: p.deviceConfig.hostname,
            tags: p.deviceConfig.tags || {},
          })),
        });
      };

      const queue = [...groups];
      const concurrency = Math.max(1, options.concurrency || 3);
      const workers = Array.from(
        { length: Math.min(concurrency, queue.length) },
        async () => {
          while (queue.length > 0) {
            const next = queue.shift();
            if (!next) return;
            const [hash, group] = next;
            try {
              await buildGroup(hash, group);
            } catch (e) {
              const plan = group[0];
              const hostnames = group.map((p) => p.deviceConfig.hostname);
              const error = (e as Error).message;
              console.error(
                `[${plan.deviceConfig.model_id} ${hash}] FAILED: ${error}`
              );
              failures.push({ hash, model_id: plan.deviceConfig.model_id, hostnames, error });
            }
          }
        }
      );
      await Promise.all(workers);

      manifest.sort((a, b) => a.filename.localeCompare(b.filename));
      const manifestPath = join(options.out, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
      console.log(`\nmanifest written to ${manifestPath}`);

      const rows = manifest.flatMap((m) =>
        m.devices.map((d) => ({
          hostname: d.hostname,
          model: m.model_id,
          version: m.version,
          image: m.filename,
        }))
      );
      rows.sort((a, b) => a.hostname.localeCompare(b.hostname));

      if (rows.length > 0) {
        const widths = {
          hostname: Math.max(8, ...rows.map((r) => r.hostname.length)),
          model: Math.max(5, ...rows.map((r) => r.model.length)),
          version: Math.max(7, ...rows.map((r) => r.version.length)),
          image: Math.max(5, ...rows.map((r) => r.image.length)),
        };
        const pad = (s: string, w: number) => s + " ".repeat(w - s.length);
        console.log(
          `\n${pad("hostname", widths.hostname)}  ${pad("model", widths.model)}  ${pad(
            "version",
            widths.version
          )}  ${pad("image", widths.image)}`
        );
        console.log(
          `${"-".repeat(widths.hostname)}  ${"-".repeat(widths.model)}  ${"-".repeat(
            widths.version
          )}  ${"-".repeat(widths.image)}`
        );
        for (const r of rows) {
          console.log(
            `${pad(r.hostname, widths.hostname)}  ${pad(r.model, widths.model)}  ${pad(
              r.version,
              widths.version
            )}  ${pad(r.image, widths.image)}`
          );
        }
      }

      console.log(
        `\nbuilt ${manifest.length} image${
          manifest.length === 1 ? "" : "s"
        } for ${rows.length} device${rows.length === 1 ? "" : "s"}`
      );

      if (failures.length > 0) {
        console.error(
          `\n${failures.length} group${
            failures.length === 1 ? "" : "s"
          } failed:`
        );
        for (const f of failures) {
          console.error(
            `  ${f.model_id} ${f.hash} (${f.hostnames.join(", ")}): ${f.error}`
          );
        }
        process.exit(1);
      }
    });

  program
    .command("verify-images")
    .description(
      "verify built images against manifest.json by recomputing sha256"
    )
    .option("--out <dir>", "directory containing built images and manifest.json", "./images")
    .action(async (options) => {
      const manifestPath = join(options.out, "manifest.json");
      const manifestRaw = readFileSync(manifestPath, "utf-8");
      const manifest = JSON.parse(manifestRaw) as Array<{
        filename: string;
        sha256: string;
        devices: { hostname: string }[];
      }>;

      let failed = 0;
      for (const entry of manifest) {
        const path = join(options.out, entry.filename);
        try {
          const { ok, actualSha256 } = await verifyImageFile({
            path,
            expectedSha256: entry.sha256,
          });
          const hostnames = entry.devices.map((d) => d.hostname).join(", ");
          if (ok) {
            console.log(`OK    ${entry.filename} (${hostnames})`);
          } else {
            failed += 1;
            console.log(
              `FAIL  ${entry.filename} (${hostnames}): expected ${entry.sha256}, got ${actualSha256}`
            );
          }
        } catch (e) {
          failed += 1;
          console.log(
            `ERROR ${entry.filename}: ${(e as Error).message}`
          );
        }
      }

      if (failed > 0) {
        console.log(`\n${failed} of ${manifest.length} image(s) failed verification`);
        process.exit(1);
      }
      console.log(`\nall ${manifest.length} image(s) verified`);
    });

  await program.parseAsync();
  process.exit(0);
};

main();
