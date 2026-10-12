// Device facts: what each device is (model, OpenWrt version, ports, radios),
// as the engine's probes read it, kept beside the intent file and never in
// it. They keep themselves fresh: a page that shows them asks for the stale
// ones (missing, or older than a day) to be read, and an apply refreshes
// them as it reads the devices; never a timer. No config values are kept:
// device UCI holds Wi-Fi keys. See CLAUDE.md, "Reading devices".
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

/** Facts older than this are read again when a page asks. */
export const factsMaxAgeMs = 24 * 60 * 60 * 1000;
/** After a failed read, a device is left alone this long. */
export const retryAfterMs = 10 * 60 * 1000;
/** A read still marked running after this is taken to have died. */
const lockTimeoutMs = 60 * 1000;

export type ReadAttempt = { at: number; error: string };

const attemptFile = (intentPath: string, hostname: string) =>
  file(intentPath, hostname).replace(/\.json$/, ".failed.json");
const lockFile = (intentPath: string) => `${dir(intentPath)}/.reading`;

const readJson = <T>(files: Pick<Platform, "readTextFile">, path: string): T | undefined => {
  try {
    return parseJson(files.readTextFile(path), path) as T;
  } catch {
    return undefined;
  }
};

/** The last failed read of each of `hostnames`, if its last read failed. */
export const readFailures = (
  files: Pick<Platform, "readTextFile">,
  intentPath: string,
  hostnames: string[]
): Record<string, ReadAttempt | undefined> =>
  Object.fromEntries(hostnames.map((h) => [h, readJson<ReadAttempt>(files, attemptFile(intentPath, h))]));

/** Which devices a page should have read: no facts, or old ones; not one that just failed. */
export const staleDevices = ({
  facts,
  failures,
  now,
}: {
  facts: Record<string, DeviceFacts | undefined>;
  failures: Record<string, ReadAttempt | undefined>;
  now: number;
}) =>
  Object.keys(facts).filter((hostname) => {
    const known = facts[hostname];
    const failed = failures[hostname];
    const old = !known || now - known.readAt > factsMaxAgeMs;
    const resting = !!failed && now - failed.at < retryAfterMs && (!known || failed.at > known.readAt);
    return old && !resting;
  });

/**
 * Read the devices whose facts are stale, at most one read at a time (a
 * lock file, so the Node server and CGI requests agree). A failure is kept,
 * so the device is not tried again for a while; a success clears it.
 */
export const refreshStale = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Platform;
  now?: () => number;
}) => {
  const { oncConfig } = await loadOncConfig({ path: intentPath, platform });
  const { ready } = provisionableDevices(oncConfig);
  const hostnames = ready.map((d) => d.hostname);
  const stale = staleDevices({
    facts: readFacts(platform, intentPath, hostnames),
    failures: readFailures(platform, intentPath, hostnames),
    now: now(),
  });
  const lock = readJson<{ at: number }>(platform, lockFile(intentPath));
  if (stale.length === 0 || (lock && now() - lock.at < lockTimeoutMs)) return;
  platform.mkdirp(dir(intentPath));
  platform.writeTextFile(lockFile(intentPath), JSON.stringify({ at: now() }));
  try {
    await Promise.all(
      ready
        .filter((d) => stale.includes(d.hostname))
        .map(async (deviceConfig) => {
          try {
            const ssh = await connectToDevice({ deviceConfig, platform });
            try {
              const schema = await getDeviceSchema({ deviceConfig, ssh });
              writeFacts(platform, intentPath, { hostname: deviceConfig.hostname, readAt: now(), schema });
              try {
                platform.removeFile(attemptFile(intentPath, deviceConfig.hostname));
              } catch {
                // Never failed: nothing to clear.
              }
            } finally {
              ssh.dispose();
            }
          } catch (e) {
            platform.writeTextFile(
              attemptFile(intentPath, deviceConfig.hostname),
              JSON.stringify({ at: now(), error: (e as Error).message })
            );
          }
        })
    );
  } finally {
    platform.removeFile(lockFile(intentPath));
  }
};
