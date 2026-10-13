// Device facts: what each device is (model, OpenWrt version, ports, radios),
// as the engine's probes read it, kept beside the intent file and never in
// it. They keep themselves fresh: a page that shows them asks for the stale
// ones (missing, or older than a day) to be read, and an apply refreshes
// them as it reads the devices; never a timer. No config values are kept:
// device UCI holds Wi-Fi keys. See CLAUDE.md, "Reading devices".
import { DeviceSchema, deviceSchemaSchema } from "./deviceSchema";
import { parseJson } from "./parseJson";
import { Platform } from "./platform";
import { isAddress, Located, locateEach } from "./locate";
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

const readJson = <T>(files: Pick<Platform, "readTextFile">, path: string): T | undefined => {
  try {
    return parseJson(files.readTextFile(path), path) as T;
  } catch {
    return undefined;
  }
};

/**
 * Every device whose facts were ever kept: Add hardware offers those no longer
 * in Hardware. A dot file, which no device's file name can be (`file`): as
 * `seen.json` it was a device named "seen"'s facts too, overwritten by it.
 */
const seenFile = (intentPath: string) => `${dir(intentPath)}/.seen.json`;
const formerSeenFile = (intentPath: string) => `${dir(intentPath)}/seen.json`;

export const listSeen = (files: Pick<Platform, "readTextFile">, intentPath: string): string[] => {
  const list = [seenFile(intentPath), formerSeenFile(intentPath)]
    .map((path) => readJson<unknown>(files, path))
    .find(Array.isArray);
  return (list ?? []).filter((h): h is string => typeof h === "string");
};

/**
 * What facts files hold. Bumped when what is read from a device changes
 * (2: radios from board.json, with their modes; 3: whether each can mesh;
 * 4: switch ports by number, and NICs beside the switch),
 * so older facts are read again; their address and host key are kept
 * meanwhile, to find the device.
 */
const factsFormat = 4;

export const writeFacts = (
  files: Pick<Platform, "mkdirp" | "writeTextFile" | "readTextFile">,
  intentPath: string,
  facts: DeviceFacts
) => {
  files.mkdirp(dir(intentPath));
  // Where it was found and what it is known by are kept unless this read
  // learnt them again: a write of a schema alone (an apply's) must never
  // drop the pinned host key, which is what keeps found addresses safe.
  const before = readFacts(files, intentPath, [facts.hostname])[facts.hostname];
  const { address, macs, hostKey } = before ?? {};
  files.writeTextFile(
    file(intentPath, facts.hostname),
    JSON.stringify({ format: factsFormat, address, macs, hostKey, ...facts }, null, 2) + "\n"
  );
  const seen = listSeen(files, intentPath);
  if (!seen.includes(facts.hostname)) {
    files.writeTextFile(seenFile(intentPath), JSON.stringify([...seen, facts.hostname]));
  }
};

/**
 * A device renamed in Hardware keeps what is known of it under its new name:
 * its pinned host key above all, without which it could only be found at the
 * address its settings give (src/locate.ts) and never be re-adopted. Nothing
 * moves onto a name that has facts of its own.
 */
export const renameFacts = (
  files: Pick<Platform, "readTextFile" | "writeTextFile" | "removeFile" | "mkdirp">,
  intentPath: string,
  from: string,
  to: string
) => {
  const stored = readJson<Record<string, unknown>>(files, file(intentPath, from));
  if (!stored || readJson(files, file(intentPath, to)) !== undefined) return;
  files.writeTextFile(file(intentPath, to), JSON.stringify({ ...stored, hostname: to }, null, 2) + "\n");
  files.removeFile(file(intentPath, from));
  files.removeFile(attemptFile(intentPath, from));
  files.writeTextFile(seenFile(intentPath), JSON.stringify(listSeen(files, intentPath).map((h) => (h === from ? to : h))));
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
        const stored = parseJson(files.readTextFile(path), path) as DeviceFacts & { format?: number };
        const schema = deviceSchemaSchema.safeParse(stored?.schema);
        if (!schema.success || typeof stored.readAt !== "number") return [hostname, undefined];
        const hostKey = stored.hostKey;
        return [
          hostname,
          {
            hostname,
            // An older format: as if never read, so it is read again.
            readAt: stored.format === factsFormat ? stored.readAt : 0,
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

export type ReadAttempt = { at: number; error: string };

const attemptFile = (intentPath: string, hostname: string) =>
  file(intentPath, hostname).replace(/\.json$/, ".failed.json");


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
  const hostKeys: Record<string, { type: string; key: string }> = {};
  // Not found (or not trusted where it was): never connected to anyway at
  // its configured name, which anyone on the network can claim in DHCP.
  const unreached: { hostname: string; error: string }[] = [];
  for (const f of found) {
    if (!("session" in f)) {
      unreached.push({ hostname: f.hostname, error: f.error });
      continue;
    }
    f.session.dispose();
    rememberLocated(platform, intentPath, f, Date.now());
    const configured = ready.find((d) => d.hostname === f.hostname)?.ipaddr;
    if (f.address !== configured) console.log(`${f.hostname}: found at ${f.address}.`);
    addresses.set(f.hostname, f.address);
    // Found by its key (anywhere but a configured address): the apply's own
    // connections are held to it too, or a box that took the address since
    // would be handed the login.
    if (f.hostKey && !(f.address === configured && isAddress(f.address))) hostKeys[f.hostname] = f.hostKey;
  }
  return {
    oncConfig: {
      ...oncConfig,
      devices: oncConfig.devices.map((d) =>
        addresses.has(d.hostname) ? { ...d, ipaddr: addresses.get(d.hostname)! } : d
      ),
    },
    hostKeys,
    unreached,
  };
};
