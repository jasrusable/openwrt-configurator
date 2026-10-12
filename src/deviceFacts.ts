// Device facts: what each device is (model, OpenWrt version, ports, radios),
// as the engine's probes read it, kept beside the intent file and never in
// it. They keep themselves fresh: a page that shows them asks for the stale
// ones (missing, or older than a day) to be read, and an apply refreshes
// them as it reads the devices; never a timer. No config values are kept:
// device UCI holds Wi-Fi keys. See CLAUDE.md, "Reading devices".
import { DeviceSchema, deviceSchemaSchema } from "./deviceSchema";
import { loadOncConfig } from "./loadConfig";
import { parseJson } from "./parseJson";
import { Platform } from "./platform";
import { Located, locateEach } from "./locate";
import { ONCConfig } from "./oncConfigSchema";
import { provisionableDevices } from "./provisionConfig";

export type DeviceFacts = {
  hostname: string;
  /** When it was read, ms since the epoch. */
  readAt: number;
  schema: DeviceSchema;
  /** Where it was last reached (src/locate.ts tries it first). */
  address?: string;
  /** Its interfaces' MACs: how the router's leases and neighbours recognise it. */
  macs?: string[];
  /** Its SSH host key (public): another address is trusted only if it shows this. */
  hostKey?: { type: string; key: string };
};

const dir = (intentPath: string) => `${intentPath}.state/devices`;
/** One plain file name per device, whatever the hostname holds. */
const file = (intentPath: string, hostname: string) =>
  `${dir(intentPath)}/${hostname.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_")}.json`;

/** Every device whose facts were ever kept: Add hardware offers those no longer in Hardware. */
const seenFile = (intentPath: string) => `${dir(intentPath)}/seen.json`;

export const listSeen = (files: Pick<Platform, "readTextFile">, intentPath: string): string[] => {
  try {
    const list = parseJson(files.readTextFile(seenFile(intentPath)), seenFile(intentPath));
    return Array.isArray(list) ? list.filter((h): h is string => typeof h === "string") : [];
  } catch {
    return [];
  }
};

export const writeFacts = (
  files: Pick<Platform, "mkdirp" | "writeTextFile" | "readTextFile">,
  intentPath: string,
  facts: DeviceFacts
) => {
  files.mkdirp(dir(intentPath));
  files.writeTextFile(file(intentPath, facts.hostname), JSON.stringify(facts, null, 2) + "\n");
  const seen = listSeen(files, intentPath);
  if (!seen.includes(facts.hostname)) {
    files.writeTextFile(seenFile(intentPath), JSON.stringify([...seen, facts.hostname]));
  }
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
        if (!schema.success || typeof stored.readAt !== "number") return [hostname, undefined];
        const hostKey = stored.hostKey;
        return [
          hostname,
          {
            hostname,
            readAt: stored.readAt,
            schema: schema.data,
            ...(typeof stored.address === "string" ? { address: stored.address } : {}),
            ...(Array.isArray(stored.macs) ? { macs: stored.macs.filter((m) => typeof m === "string") } : {}),
            ...(hostKey && typeof hostKey.type === "string" && typeof hostKey.key === "string"
              ? { hostKey: { type: hostKey.type, key: hostKey.key } }
              : {}),
          },
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

/** Keep what was learnt while locating a device: where it is, its MACs and host key, its schema. */
export const rememberLocated = (
  files: Pick<Platform, "mkdirp" | "writeTextFile" | "readTextFile">,
  intentPath: string,
  located: Located,
  now: number
) =>
  writeFacts(files, intentPath, {
    hostname: located.hostname,
    readAt: now,
    schema: located.schema,
    address: located.address,
    macs: located.macs,
    ...(located.hostKey ? { hostKey: located.hostKey } : {}),
  });

/** A read that failed: the device is rested for a while (staleDevices). */
export const recordFailure = (
  files: Pick<Platform, "mkdirp" | "writeTextFile">,
  intentPath: string,
  hostname: string,
  attempt: ReadAttempt
) => {
  files.mkdirp(dir(intentPath));
  files.writeTextFile(attemptFile(intentPath, hostname), JSON.stringify(attempt));
};

/** A read that worked: any failure before it is forgotten. */
export const clearFailure = (files: Pick<Platform, "removeFile">, intentPath: string, hostname: string) => {
  try {
    files.removeFile(attemptFile(intentPath, hostname));
  } catch {
    // It never failed: nothing to clear.
  }
};

/**
 * Read the devices whose facts are stale, at most one read at a time (a
 * lock file, so the Node server and CGI requests agree). Each is found
 * first (src/locate.ts), the router too, as its leases help find the rest.
 * A failure is kept, so the device is not tried again for a while.
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
  const facts = readFacts(platform, intentPath, hostnames);
  const stale = staleDevices({ facts, failures: readFailures(platform, intentPath, hostnames), now: now() });
  const lock = readJson<{ at: number }>(platform, lockFile(intentPath));
  if (stale.length === 0 || (lock && now() - lock.at < lockTimeoutMs)) return;
  platform.mkdirp(dir(intentPath));
  platform.writeTextFile(lockFile(intentPath), JSON.stringify({ at: now() }));
  try {
    const wanted = ready.filter((d) => stale.includes(d.hostname) || d.tags?.role === "router");
    await Promise.all(
      locateEach({ devices: wanted, facts, platform }).map((found) =>
        found.then((f) => {
          if ("session" in f) {
            try {
              rememberLocated(platform, intentPath, f, now());
              clearFailure(platform, intentPath, f.hostname);
            } finally {
              f.session.dispose();
            }
          } else if (stale.includes(f.hostname)) {
            recordFailure(platform, intentPath, f.hostname, { at: now(), error: f.error });
          }
        })
      )
    );
  } finally {
    platform.removeFile(lockFile(intentPath));
  }
};

/**
 * The config with each device's address where it was found (src/locate.ts),
 * for an apply: a device that moved is applied where it is, and only once it
 * has shown it is that device. One not found keeps its configured address,
 * and the apply reports it as unreachable as before.
 */
export const withLocatedAddresses = async (oncConfig: ONCConfig, intentPath: string, platform: Platform) => {
  const { ready } = provisionableDevices(oncConfig);
  const facts = readFacts(platform, intentPath, ready.map((d) => d.hostname));
  const found = await Promise.all(locateEach({ devices: ready, facts, platform }));
  const addresses = new Map<string, string>();
  for (const f of found) {
    if (!("session" in f)) continue;
    f.session.dispose();
    rememberLocated(platform, intentPath, f, Date.now());
    if (f.address !== ready.find((d) => d.hostname === f.hostname)?.ipaddr) {
      console.log(`${f.hostname}: found at ${f.address}.`);
    }
    addresses.set(f.hostname, f.address);
  }
  return {
    ...oncConfig,
    devices: oncConfig.devices.map((d) =>
      addresses.has(d.hostname) ? { ...d, ipaddr: addresses.get(d.hostname)! } : d
    ),
  };
};
