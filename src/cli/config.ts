// What a config compiles to, and the script an apply would run on each
// device (read from the device, as an apply would): `compile` and
// `print-uci-commands`. Both hide secrets unless asked (src/secretOptions.ts).
import { CommandSpec } from "../args";
import { readApplyPlan } from "../applyDiff";
import { planText } from "../applyPlanText";
import { installedPackages, managedFiles, runProbes, uciConfigs } from "../deviceProbes";
import { getDeviceSchema } from "../getDeviceSchema";
import { getDeviceScript, managedFilesManifest } from "../getDeviceScript";
import { getOpenWrtState } from "../engine/getOpenWrtState";
import { describePatches } from "../intent/patches";
import { loadConfigOrThrow } from "../loadConfig";
import { printPlan } from "../lowLevel/print";
import { connectToDevice, provisionableDevices, reportSkipped } from "../apply/provisionConfig";
import { assertSupportedRelease } from "../release";
import { redactSecretFields, redactValue } from "../secrets";
import { redactor } from "../secretOptions";
import { CliContext, locatedOrRefused } from "./context";

export const compileCommand = ({ platform }: CliContext): CommandSpec => ({
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
    const { plan, secrets, intent, lowLevel } = await loadConfigOrThrow({
      path: configPath,
      platform,
    });
    // On stderr, so stdout stays the config.
    if (intent) console.warn(describePatches(intent));
    // A low-level config as written (checked); an intent as the plan it compiles to.
    const config = lowLevel ?? printPlan(plan);
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
    const printed = options.showSecrets ? config : hideSecrets(redactSecretFields(config));
    console.log(JSON.stringify(printed, null, 2));
  },
});

export const printUciCommand = ({ platform }: CliContext): CommandSpec => ({
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
        "print passwords and keys (default: redact)",
    },
  ],
  action: async ([configPath], options) => {
    const loaded = await loadConfigOrThrow({
      path: configPath,
      platform,
    });
    const { secrets } = loaded;
    // Found and held to their keys as an apply would (see provision).
    const { plan, hostKeys } = loaded.intent
      ? await locatedOrRefused(loaded.plan, configPath, platform)
      : { plan: loaded.plan, hostKeys: {} as Record<string, { type: string; key: string }> };
    const { ready: deviceConfigs, skipped } = provisionableDevices(plan);
    reportSkipped(skipped);
    // What it all comes to, as `provision --plan` says it, above the scripts.
    if (loaded.intent) {
      const summary = await readApplyPlan({ intentPath: configPath, platform, now: Date.now });
      const header = summary.ok ? planText(summary.value, { lines: false }) : `The change plan could not be read: ${summary.error.message}`;
      console.log(`${header.split("\n").map((line) => `# ${line}`.trimEnd()).join("\n")}\n`);
    }

    // Each device keeps its own schema. Looking it up by model_id meant two
    // devices of the same model shared one schema, so the second was built
    // against the first device's UCI sections and firmware version.
    const devices = await Promise.all(
      deviceConfigs.map(async (deviceConfig) => {
        const ssh = await connectToDevice({
          deviceConfig,
          identityPath: options.identity,
          hostKey: hostKeys[deviceConfig.hostname],
          platform,
        });
        try {
          const deviceSchema = await getDeviceSchema({ deviceConfig, ssh });
          assertSupportedRelease(deviceConfig.hostname, deviceSchema.version);
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
          plan: plan,
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
            : redactor((value) => redactValue(value, secrets)),
        });
        console.log(`#device ${deviceConfig.hostname}`);
        console.log(commands.join("\n"));
      } finally {
        ssh.dispose();
      }
    }
  },
});
