// `capture-device-schema`: what each device's hardware is (ports, radios,
// version; no option values), kept as a test fixture.
import { CommandSpec } from "../args";
import { getDeviceSchema } from "../getDeviceSchema";
import { loadConfigOrThrow } from "../loadConfig";
import { join } from "../posixPath";
import { connectToDevice, provisionableDevices, reportSkipped } from "../apply/provisionConfig";
import { CliContext, locatedOrRefused } from "./context";

export const captureSchemaCommand = ({ platform }: CliContext): CommandSpec => ({
  name: "capture-device-schema",
  description:
    "record each device's hardware schema (ports, radios, version; no option values) as a test fixture",
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
    const loaded = await loadConfigOrThrow({ path: configPath, platform });
    // Found and held to their keys as an apply would: it logs in as root.
    const { plan, hostKeys } = loaded.intent
      ? await locatedOrRefused(loaded.plan, configPath, platform)
      : { plan: loaded.plan, hostKeys: {} as Record<string, { type: string; key: string }> };
    const { ready, skipped } = provisionableDevices(plan);
    reportSkipped(skipped);
    platform.mkdirp(options.out);
    for (const deviceConfig of ready) {
      const ssh = await connectToDevice({
        deviceConfig,
        identityPath: options.identity,
        hostKey: hostKeys[deviceConfig.hostname],
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
