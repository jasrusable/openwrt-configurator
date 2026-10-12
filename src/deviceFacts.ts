// Device facts: what each device is (model, OpenWrt version, ports, radios),
// as the engine's probes read it, kept beside the intent file and never in
// it. Read when asked ("Read from devices") or by an apply; never on a timer.
// No config values are kept: device UCI holds Wi-Fi keys. See CLAUDE.md,
// "Reading devices".
import { DeviceSchema, deviceSchemaSchema } from "./deviceSchema";
import { getDeviceSchema } from "./getDeviceSchema";
import { loadOncConfig } from "./loadConfig";
import { parseJson } from "./parseJson";
import { Platform } from "./platform";
import { connectToDevice, provisionableDevices } from "./provisionConfig";

export type DeviceFacts = {
  hostname: string;
  /** When it was read, ms since the epoch. */
  readAt: number;
  schema: DeviceSchema;
};

const dir = (intentPath: string) => `${intentPath}.state/devices`;
/** One plain file name per device, whatever the hostname holds. */
const file = (intentPath: string, hostname: string) =>
  `${dir(intentPath)}/${hostname.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_")}.json`;

export const writeFacts = (
  files: Pick<Platform, "mkdirp" | "writeTextFile">,
  intentPath: string,
  facts: DeviceFacts
) => {
  files.mkdirp(dir(intentPath));
  files.writeTextFile(file(intentPath, facts.hostname), JSON.stringify(facts, null, 2) + "\n");
};

/** The facts last read for each of `hostnames`; a device never read has none. */
export const readFacts = (
  files: Pick<Platform, "readTextFile">,
  intentPath: string,
  hostnames: string[]
): Record<string, DeviceFacts | undefined> =>
  Object.fromEntries(
    hostnames.map((hostname) => {
      try {
        const path = file(intentPath, hostname);
        const stored = parseJson(files.readTextFile(path), path) as DeviceFacts;
        const schema = deviceSchemaSchema.safeParse(stored?.schema);
        return [
          hostname,
          schema.success && typeof stored.readAt === "number"
            ? { hostname, readAt: stored.readAt, schema: schema.data }
            : undefined,
        ];
      } catch {
        return [hostname, undefined];
      }
    })
  );

export type ReadResult = { hostname: string; ok: true } | { hostname: string; ok: false; error: string };

/**
 * Read every device's facts now, read-only, all at once, and keep them. Each
 * device gets its own session, closed when done; one that cannot be reached
 * keeps the facts it had.
 */
export const readDevices = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  now?: () => number;
}): Promise<ReadResult[]> => {
  const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
  const { ready, skipped } = provisionableDevices(oncConfig);
  const read = await Promise.all(
    ready.map(async (deviceConfig): Promise<ReadResult> => {
      try {
        const ssh = await connectToDevice({ deviceConfig, platform });
        try {
          const schema = await getDeviceSchema({ deviceConfig, ssh });
          writeFacts(platform, intentPath, { hostname: deviceConfig.hostname, readAt: now(), schema });
          return { hostname: deviceConfig.hostname, ok: true };
        } finally {
          ssh.dispose();
        }
      } catch (e) {
        return { hostname: deviceConfig.hostname, ok: false, error: (e as Error).message };
      }
    })
  );
  return [
    ...read,
    ...skipped.map(({ hostname, reason }) => ({ hostname, ok: false as const, error: reason })),
  ];
};
