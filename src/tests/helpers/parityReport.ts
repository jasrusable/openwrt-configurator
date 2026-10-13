// Everything the pipeline derives from a config, rendered as one string, so
// the same code can be run under Node and QuickJS and the outputs compared.
// Lives under helpers/ so ava does not run it as a test file.
import { getDeviceBuildPlan } from "../../getBuildPlan";
import { getDeviceSchema } from "../../getDeviceSchema";
import { getDeviceScript, getFinaliseCommands } from "../../getDeviceScript";
import { getOpenWrtState } from "../../getOpenWrtState";
import { loadOncConfig } from "../../loadConfig";
import { Platform } from "../../platform";
import { parseUciExport } from "../../uci";

export const parityConfigs = [
  "src/tests/main/config.json",
  "src/tests/main/config2.json",
  "sampleConfigs/basic.json",
  // An intent: compiled first, as on a router, where this is what runs.
  "sampleConfigs/intent.json",
];

/** An intent holds no models; give its devices the captured ones by role. */
const capturedModels: Record<string, string> = {
  router: "friendlyarm,nanopi-r6s",
  "access-point": "zyxel,nwa50ax-pro",
};
const withCapturedModel = <D extends { model_id?: string; tags?: Record<string, unknown> }>(device: D): D =>
  device.model_id ? device : { ...device, model_id: capturedModels[String(device.tags?.role)] };

/** What a device's uciConfigs probe might print: the wipe is computed from it. */
const deviceExport = [
  "package network",
  "",
  "config interface 'loopback'",
  "\toption device 'lo'",
  "",
  "config globals 'globals'",
  "\toption ula_prefix 'fd00::/48'",
  "",
  "package firewall",
  "",
  "config rule",
  "\toption name 'it'\\''s'",
  "\tlist proto 'tcp'",
  "\tlist proto 'udp'",
  "",
  "config rule",
  "\toption note 'two",
  "config lines'",
  "",
  "package luci",
  "",
  "config core 'main'",
  "__ONC_UNREADABLE__ broken",
].join("\n");
const deviceConfigs = parseUciExport(deviceExport);

const attempt = <T>(fn: () => T) => {
  try {
    return fn();
  } catch (e) {
    return { error: (e as Error).message };
  }
};

/** Run from the repository root: device schemas are read from ./deviceSchemas. */
export const parityReport = async ({ platform }: { platform: Platform }) => {
  const report: unknown[] = [deviceConfigs];
  for (const configPath of parityConfigs) {
    const { oncConfig } = await loadOncConfig({
      path: configPath,
      platform,
      lookup: async (name) => `placeholder-${name}`,
    });
    for (const deviceConfig of oncConfig.devices.map(withCapturedModel)) {
      const deviceSchema = await getDeviceSchema({
        deviceConfig,
        local: platform,
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
                    current: deviceConfigs.configs,
                  }),
                  commits: getFinaliseCommands({
                    state,
                    current: deviceConfigs.configs,
                  }),
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
