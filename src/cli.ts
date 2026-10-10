import { DeviceBuildPlan } from "./getBuildPlan";
import { getDeviceScript, managedFilesManifest } from "./getDeviceScript";
import {
  installedPackages,
  managedFiles,
  runProbes,
  uciConfigs,
} from "./deviceProbes";
import { CommandSpec, runCli } from "./args";
import { join } from "./paths";
import { Platform } from "./platform";
import {
  connectToDevice,
  provisionableDevices,
  provisionConfig,
  reportSkipped,
} from "./provisionConfig";
import { confirmTiming } from "./confirm";
import { getDeviceSchema } from "./getDeviceSchema";
import { loadOncConfig } from "./loadConfig";
import { cgiResponse, uiHandler } from "./server/handlers";
import {
  redactSecretFields,
  redactValue,
  setKeychainSecret,
} from "./resolveSecrets";
import { getOpenWrtState } from "./getOpenWrtState";
import { getDeviceBuildPlan } from "./getBuildPlan";
import {
  downloadImage,
  getProfileTarget,
  pickSysupgradeImage,
  pollBuild,
  requestBuild,
  verifyImageFile,
} from "./buildImage";

export const main = async ({
  argv,
  platform,
}: {
  argv: string[];
  platform: Platform;
}) => {
  const timing = confirmTiming(platform.env("ONC_TEST_MIN_CONFIRM_WINDOW"));
  const { minimumConfirmTimeoutSeconds } = timing;
  if (timing.shortened) {
    console.warn(
      `Warning: ONC_TEST_MIN_CONFIRM_WINDOW shortens the confirm window to ` +
        `${timing.minimumConfirmWindowMs / 1000}s. For tests only.`
    );
  }

  const commands: CommandSpec[] = [];

  commands.push({
    name: "provision",
    description: "provision configuration to devices",
    args: [{ name: "config-file", description: "config file to provision" }],
    options: [
      {
        flags: "--no-confirm",
        description:
          "skip the commit-confirm rollback (the device will not restore itself if the new config cuts it off)",
      },
      {
        flags: "--rollback <mode>",
        description:
          "how a device recovers if a provision is never confirmed: " +
          "reload-then-reboot (revert, reload services, reboot only if access does not come back), " +
          "reload (never reboot), or reboot (always reboot)",
        parse: (v) => {
          if (!["reload", "reboot", "reload-then-reboot"].includes(v)) {
            throw new Error(
              `--rollback must be one of reload, reboot, reload-then-reboot (got "${v}").`
            );
          }
          return v;
        },
        default: "reload-then-reboot",
      },
      {
        flags: "--confirm-timeout <seconds>",
        description:
          "seconds to reconnect and confirm before the device rolls back",
        parse: (v) => {
          const seconds = parseInt(v, 10);
          // An unparsed value would reach the device as `sleep NaN`.
          if (
            !Number.isFinite(seconds) ||
            seconds < minimumConfirmTimeoutSeconds
          ) {
            throw new Error(
              `--confirm-timeout must be a whole number of seconds, at least ${minimumConfirmTimeoutSeconds} (got "${v}").`
            );
          }
          return seconds;
        },
        default: 90,
      },
      {
        flags: "--identity <path>",
        description:
          "SSH private key (like ssh -i). Overrides ssh_auth.private_key_path. Password is optional when a key or agent is used.",
      },
    ],
    action: async ([configPath], options) => {
      const { oncConfig } = await loadOncConfig({ path: configPath, platform });
      await provisionConfig({
        oncConfig,
        confirm: options.confirm,
        confirmTimeoutSeconds: options.confirmTimeout,
        rollbackMode: options.rollback,
        identityPath: options.identity,
        platform,
        timing,
      });
    },
  });

  commands.push({
    name: "compile",
    description:
      "print the low-level config a config file compiles to (an intent file, or a low-level one as validated)",
    args: [{ name: "config-file", description: "config file to compile" }],
    options: [
      {
        flags: "--show-secrets",
        description: "print passwords and keys (default: redact)",
      },
    ],
    action: async ([configPath], options) => {
      const { oncConfig, secrets } = await loadOncConfig({
        path: configPath,
        platform,
      });
      const hideSecrets = (value: unknown): unknown =>
        typeof value === "string"
          ? redactValue(value, secrets)
          : Array.isArray(value)
          ? value.map(hideSecrets)
          : value && typeof value === "object"
          ? Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, hideSecrets(v)])
            )
          : value;
      const printed = options.showSecrets
        ? oncConfig
        : hideSecrets(redactSecretFields(oncConfig));
      console.log(JSON.stringify(printed, null, 2));
    },
  });

  const uiOptions = [
    {
      flags: "--ui-dir <dir>",
      description: "the built web UI (npm run ui:build)",
      default: "dist/ui",
    },
  ];

  commands.push({
    name: "ui",
    description:
      "serve the web UI for an intent file on this machine (on a router, uhttpd runs `cgi` instead)",
    args: [{ name: "intent-file", description: "the intent file to edit" }],
    options: [
      ...uiOptions,
      { flags: "--port <port>", description: "port to listen on", default: "8080" },
      {
        flags: "--host <host>",
        description: "address to listen on; the API returns passwords, so keep it local",
        default: "127.0.0.1",
      },
    ],
    action: async ([intentPath], options) => {
      if (!platform.serve) {
        throw new Error(
          "This runtime cannot listen on a port. On a router, have uhttpd run `cgi`."
        );
      }
      console.log(`Serving ${intentPath} at http://${options.host}:${options.port}/`);
      await platform.serve(
        uiHandler({ intentPath, uiRoot: options.uiDir, platform }),
        { host: options.host, port: Number(options.port) }
      );
    },
  });

  commands.push({
    name: "cgi",
    description:
      "answer one web UI request as a CGI program (what uhttpd runs on a router)",
    args: [{ name: "intent-file", description: "the intent file to edit" }],
    options: uiOptions,
    action: async ([intentPath], options) => {
      const length = Number(platform.env("CONTENT_LENGTH") || 0);
      const response = await uiHandler({
        intentPath,
        uiRoot: options.uiDir,
        platform,
      })({
        method: platform.env("REQUEST_METHOD") || "GET",
        path: platform.env("PATH_INFO") || "/",
        body: length > 0 ? platform.readStdin() : "",
      });
      console.log(cgiResponse(response));
    },
  });

  commands.push({
    name: "print-uci-commands",
    description: "print uci commands for configuration",
    args: [
      {
        name: "config-file",
        description: "config file to print uci commands for",
      },
    ],
    options: [
      {
        flags: "--identity <path>",
        description:
          "SSH private key (like ssh -i). Overrides ssh_auth.private_key_path.",
      },
      {
        flags: "--show-secrets",
        description:
          "print resolved secret values (default: redact as { $secret: name })",
      },
    ],
    action: async ([configPath], options) => {
      const { oncConfig, secrets } = await loadOncConfig({
        path: configPath,
        platform,
      });
      const { ready: deviceConfigs, skipped } = provisionableDevices(oncConfig);
      reportSkipped(skipped);

      // Each device keeps its own schema. Looking it up by model_id meant two
      // devices of the same model shared one schema, so the second was built
      // against the first device's UCI sections and firmware version.
      const devices = await Promise.all(
        deviceConfigs.map(async (deviceConfig) => {
          const ssh = await connectToDevice({
            deviceConfig,
            identityPath: options.identity,
            platform,
          });
          try {
            const deviceSchema = await getDeviceSchema({ deviceConfig, ssh });
            // The session stays open: the script is built against it below.
            return { deviceConfig, deviceSchema, ssh };
          } catch (e) {
            ssh.dispose();
            throw e;
          }
        })
      );

      for (const { deviceConfig, deviceSchema, ssh } of devices) {
        try {
          const state = getOpenWrtState({
            oncConfig: oncConfig,
            deviceConfig,
            deviceSchema,
          });

          // Build against the live session so package diffing and the managed
          // file manifest are resolved the same way `provision` resolves them.
          // Without it, every package the config names is listed as an install
          // and every removal it names as a removal, regardless of what is
          // actually on the device — which badly overstates the change. It
          // printed a 21-package `apk del` cascade for packages that were not
          // even installed, and a dry run nobody can trust is worse than none.
          const facts = await runProbes(ssh, {
            installedPackages,
            managedFiles: managedFiles(managedFilesManifest),
            uciConfigs,
          });
          const commands = getDeviceScript({
            state,
            installedPackages: facts.installedPackages,
            managedFiles: facts.managedFiles,
            current: facts.uciConfigs.configs,
            redact: options.showSecrets
              ? undefined
              : (value) => redactValue(value, secrets),
          });
          console.log(`#device ${deviceConfig.hostname}`);
          console.log(commands.join("\n"));
        } finally {
          ssh.dispose();
        }
      }
    },
  });

  commands.push({
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
      const { oncConfig, secrets } = await loadOncConfig({
        path: configPath,
        platform,
      });
      const deviceConfigs = oncConfig.devices.filter(
        (device) => device.enabled !== false
      );

      const plans = deviceConfigs.map((deviceConfig) =>
        getDeviceBuildPlan({ oncConfig, deviceConfig })
      );

      const groupKey = (plan: DeviceBuildPlan) =>
        platform
          .sha256(
            JSON.stringify({
              version: plan.version,
              model_id: plan.deviceConfig.model_id,
              packages: [...plan.packages].sort(),
              uciDefaults: plan.uciDefaults,
            })
          )
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
        `${plan.deviceConfig.model_id.replace(",", "_")}-${
          plan.version
        }-${hash}.bin`;

      if (options.dryRun) {
        for (const [hash, group] of groups) {
          const plan = group[0];
          let target: string | undefined;
          let profile: string | undefined;
          try {
            const resolved = await getProfileTarget({
              version: plan.version,
              modelId: plan.deviceConfig.model_id,
              platform,
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
          console.log(
            options.showSecrets
              ? plan.uciDefaults
              : getDeviceBuildPlan({
                  oncConfig,
                  deviceConfig: plan.deviceConfig,
                  redact: (value) => redactValue(value, secrets),
                }).uciDefaults
          );
          console.log("# --- end ---\n");
        }
        return;
      }

      platform.mkdirp(options.out);

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
          platform,
        });
        console.log(`[${tag}] requesting build (${target}/${profile})...`);
        const { requestHash } = await requestBuild({
          req: {
            version: plan.version,
            target,
            profile,
            packages: plan.packages,
            defaults: plan.uciDefaults,
          },
          platform,
        });
        console.log(`[${tag}] build queued: ${requestHash}`);
        const result = await pollBuild({ requestHash, platform });
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
          platform,
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
              failures.push({
                hash,
                model_id: plan.deviceConfig.model_id,
                hostnames,
                error,
              });
            }
          }
        }
      );
      await Promise.all(workers);

      manifest.sort((a, b) => a.filename.localeCompare(b.filename));
      const manifestPath = join(options.out, "manifest.json");
      platform.writeTextFile(
        manifestPath,
        JSON.stringify(manifest, null, 2) + "\n"
      );
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
          `\n${pad("hostname", widths.hostname)}  ${pad(
            "model",
            widths.model
          )}  ${pad("version", widths.version)}  ${pad("image", widths.image)}`
        );
        console.log(
          `${"-".repeat(widths.hostname)}  ${"-".repeat(
            widths.model
          )}  ${"-".repeat(widths.version)}  ${"-".repeat(widths.image)}`
        );
        for (const r of rows) {
          console.log(
            `${pad(r.hostname, widths.hostname)}  ${pad(
              r.model,
              widths.model
            )}  ${pad(r.version, widths.version)}  ${pad(
              r.image,
              widths.image
            )}`
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
        platform.exit(1);
      }
    },
  });

  commands.push({
    name: "capture-device-schema",
    description:
      "record each device's hardware schema (ports, radios, section types, version; no option values) as a test fixture",
    args: [
      { name: "config-file", description: "config file naming the devices" },
    ],
    options: [
      {
        flags: "--out <dir>",
        description: "directory to write <model_id>.json into",
        default: "./deviceSchemas",
      },
      {
        flags: "--identity <path>",
        description: "SSH private key (like ssh -i).",
      },
    ],
    action: async ([configPath], options) => {
      const { oncConfig } = await loadOncConfig({ path: configPath, platform });
      const { ready, skipped } = provisionableDevices(oncConfig);
      reportSkipped(skipped);
      platform.mkdirp(options.out);
      for (const deviceConfig of ready) {
        const ssh = await connectToDevice({
          deviceConfig,
          identityPath: options.identity,
          platform,
        });
        try {
          // Read-only: introspection only, the same as print-uci-commands.
          const schema = await getDeviceSchema({ deviceConfig, ssh });
          // The name comes from the device's board.json: keep it to one plain
          // file name, whatever the device reports.
          const path = join(
            options.out,
            `${schema.name.replace(/[^A-Za-z0-9,._-]/g, "_").replace(/^\.+/, "_")}.json`
          );
          platform.writeTextFile(path, JSON.stringify(schema, null, 2) + "\n");
          console.log(`${deviceConfig.hostname}: wrote ${path}`);
        } finally {
          ssh.dispose();
        }
      }
    },
  });

  commands.push({
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
      const manifestPath = join(options.out, "manifest.json");
      const manifestRaw = platform.readTextFile(manifestPath);
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
            platform,
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
          console.log(`ERROR ${entry.filename}: ${(e as Error).message}`);
        }
      }

      if (failed > 0) {
        console.log(
          `\n${failed} of ${manifest.length} image(s) failed verification`
        );
        platform.exit(1);
      }
      console.log(`\nall ${manifest.length} image(s) verified`);
    },
  });

  commands.push({
    name: "secrets set",
    description:
      'prompt for a value and store it in the macOS keychain for { "$secret": "name" } refs (the value is never printed)',
    args: [
      {
        name: "name",
        description: "secret name matching the $secret field in the config",
      },
    ],
    action: async ([name]) => {
      await setKeychainSecret({ name, platform });
    },
  });

  await runCli(
    {
      name: "openwrt-configurator",
      description: "OpenWrt Configurator",
      version: "0.1.0",
      commands,
    },
    argv
  );
};

/** Run the CLI on the given platform, exiting when done. */
export const run = ({
  argv,
  platform,
}: {
  argv: string[];
  platform: Platform;
}) =>
  main({ argv, platform })
    .then(() => platform.exit(0))
    .catch((e) => {
      // Without this a failure surfaces as an unhandled rejection and a stack
      // trace rather than a readable message.
      console.error(`\nError: ${(e as Error)?.message ?? e}`);
      platform.exit(1);
    });
