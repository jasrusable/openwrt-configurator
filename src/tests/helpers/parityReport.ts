// Everything the pipeline derives from a config, rendered as one string, so
// the same code can be run under Node and QuickJS and the outputs compared.
// Lives under helpers/ so ava does not run it as a test file.
import { getDeviceBuildPlan } from "../../getBuildPlan";
import { getDeviceSchema } from "../../getDeviceSchema";
import { getDeviceScript, getRevertCommands } from "../../getDeviceScript";
import { getOpenWrtState } from "../../getOpenWrtState";
import { loadOncConfig } from "../../loadConfig";

export const parityConfigs = [
  "src/tests/main/config.json",
  "src/tests/main/config2.json",
  "sampleConfigs/basic.json",
];

const attempt = <T>(fn: () => T) => {
  try {
    return fn();
  } catch (e) {
    return { error: (e as Error).message };
  }
};

/** Run from the repository root: device schemas are read from ./deviceSchemas. */
export const parityReport = async () => {
  const report: unknown[] = [];
  for (const configPath of parityConfigs) {
    const { oncConfig } = await loadOncConfig(configPath, {
      lookup: async (name) => `placeholder-${name}`,
    });
    for (const deviceConfig of oncConfig.devices) {
      const deviceSchema = await getDeviceSchema({
        deviceConfig,
        useLocal: true,
      }).catch((e) => ({ error: (e as Error).message }));
      const device = {
        config: configPath,
        hostname: deviceConfig.hostname,
        script:
          "error" in deviceSchema
            ? deviceSchema
            : attempt(() => {
                const state = getOpenWrtState({
                  oncConfig,
                  deviceConfig,
                  deviceSchema,
                });
                return {
                  commands: getDeviceScript({
                    state,
                    installedPackages: ["dnsmasq", "firewall4", "curl"],
                    managedFiles: ["/etc/onc-parity-stale"],
                  }),
                  reverts: getRevertCommands(state),
                };
              }),
        buildPlan: attempt(() => {
          const plan = getDeviceBuildPlan({
            oncConfig: {
              ...oncConfig,
              version: oncConfig.version ?? "25.12.5",
            },
            deviceConfig,
          });
          return { packages: plan.packages, uciDefaults: plan.uciDefaults };
        }),
      };
      report.push(device);
    }
  }
  return JSON.stringify(report, null, 1);
};
