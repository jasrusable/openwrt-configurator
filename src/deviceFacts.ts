// Device facts: what each device is (model, OpenWrt version, ports, radios),
// as the engine's probes read it, kept beside the intent file and never in
// it (kept by src/store.ts). They keep themselves fresh: every read that
// finds a device renews them (the status collector's too), a page that shows
// them asks for the stale ones (missing, or older than a day), and an apply
// refreshes them as it reads the devices. No config values are kept: device
// UCI holds Wi-Fi keys. See CLAUDE.md, "Reading devices".
import { z } from "zod";
import { deviceSchemaSchema } from "./deviceSchema";
import { Platform } from "./platform";
import { isAddress, Located, locateEach } from "./locate";
import { Plan } from "./plan/types";
import { provisionableDevices } from "./apply/provisionConfig";
import { fileName, move, read, remove, stateLayout, StoreFiles, StoreKey, write } from "./store";

/** What finds a device again and holds it to its identity: kept through any change of what else is known. */
const pinsSchema = z.object({
  /** Where it was last reached (src/locate.ts tries it first). */
  address: z.string().optional(),
  /** Its interfaces' MACs: how the router's leases and neighbours recognise it. */
  macs: z.array(z.string()).optional(),
  /** Its SSH host key (public): another address is trusted only if it shows this. */
  hostKey: z.object({ type: z.string(), key: z.string() }).optional(),
});
export type DevicePins = z.infer<typeof pinsSchema>;

const factsSchema = pinsSchema.extend({
  hostname: z.string(),
  /** When it was read, ms since the epoch. */
  readAt: z.number(),
  schema: deviceSchemaSchema,
});
export type DeviceFacts = z.infer<typeof factsSchema>;

const devicesDir = (intentPath: string) => stateLayout(intentPath).devices;

/**
 * What facts files hold. Raised when what is read from a device changes
 * (2: radios from board.json, with their modes; 3: whether each can mesh;
 * 4: switch ports by number, and NICs beside the switch; 5: kept by the
 * store), so older facts are read again: as if never read (`readAt` 0),
 * their address and host key kept meanwhile, to find the device.
 */
const factsFormat = 5;

/** Format 4, written before the store as the facts themselves with a `format` beside them. */
const beforeStore = 4;

const factsKeyAt = (path: string): StoreKey<DeviceFacts> => ({
  path,
  schema: factsSchema,
  format: factsFormat,
  upgrade: (stored) => {
    const flat = stored as { format?: unknown } | undefined;
    return flat && typeof flat === "object" && flat.format === beforeStore ? stored : { ...flat, readAt: 0 };
  },
});

/**
 * The same file, read only for its pins, whatever format the rest is in: a
 * device's facts can go stale or stop parsing (a format change) without
 * losing what finds it again and holds it to its key.
 */
const pinsKeyAt = (path: string): StoreKey<DevicePins> => ({
  path,
  schema: pinsSchema,
  format: factsFormat,
  upgrade: (stored) => stored,
});

const factsPath = (intentPath: string, hostname: string) => `${devicesDir(intentPath)}/${fileName(hostname)}.json`;

/** One file per device, whatever the hostname holds. */
const factsKey = (intentPath: string, hostname: string) => factsKeyAt(factsPath(intentPath, hostname));

/** A device's file: its name and .json, and a hostname has no dots (namePattern). */
const deviceFile = (name: string) => /^[^.]+\.json$/.test(name);

/**
 * Files kept here before the store, read by nothing since: named for no
 * device (failed reads `<name>.failed.json`, inspections
 * `inspected-<address>.json`, the list `.seen.json`), or the list of devices
 * seen at `seen.json`, which a device named "seen" may hold its facts in.
 */
const leftover = (files: Pick<Platform, "readTextFile">, dir: string, name: string) => {
  if (!name.endsWith(".json")) return false;
  if (!deviceFile(name)) return true;
  if (name !== "seen.json") return false;
  try {
    return Array.isArray(JSON.parse(files.readTextFile(`${dir}/${name}`)));
  } catch {
    return false;
  }
};

/**
 * Every device whose facts were ever kept: Add hardware offers those no
 * longer in Hardware. One whose facts no longer read (an older format) still
 * counts, by its file's name. Clears what came before the store on the way.
 */
export const listSeen = (files: Pick<Platform, "readTextFile" | "listDir" | "removeFile">, intentPath: string): string[] => {
  const dir = devicesDir(intentPath);
  const [old, current] = files
    .listDir(dir)
    .reduce<[string[], string[]]>(
      ([old, current], name) =>
        leftover(files, dir, name) ? [[...old, name], current] : deviceFile(name) ? [old, [...current, name]] : [old, current],
      [[], []]
    );
  old.forEach((name) => files.removeFile(`${dir}/${name}`));
  return current.map((name) => read(files, factsKeyAt(`${dir}/${name}`))?.hostname ?? name.slice(0, -".json".length));
};

export const writeFacts = (files: StoreFiles, intentPath: string, facts: DeviceFacts) => {
  // Where it was found and what it is known by are kept unless this read
  // learnt them again: a write of a schema alone (an apply's) must never
  // drop the pinned host key, which is what keeps found addresses safe. Read
  // as pins alone, so facts that no longer parse keep them too.
  const pins = read(files, pinsKeyAt(factsPath(intentPath, facts.hostname))) ?? {};
  write(files, factsKey(intentPath, facts.hostname), { ...pins, ...facts });
};

/**
 * A device renamed in Hardware keeps what is known of it under its new name:
 * its pinned host key above all, without which it could only be found at the
 * address its settings give (src/locate.ts) and never be re-adopted. Nothing
 * moves onto a name that has facts of its own.
 */
export const renameFacts = (files: StoreFiles, intentPath: string, from: string, to: string) => {
  // As stored, pins and all, even facts that no longer parse; their hostname
  // inside is the old one, which readFacts always takes from the name asked.
  const known = (hostname: string) => read(files, pinsKeyAt(factsPath(intentPath, hostname))) !== undefined;
  if (!known(from) || known(to)) return;
  move(files, factsKey(intentPath, from), factsKey(intentPath, to));
  remove(files, attemptKey(intentPath, from));
};

/** The facts last read for each of `hostnames`; a device never read has none. */
export const readFacts = (
  files: Pick<Platform, "readTextFile">,
  intentPath: string,
  hostnames: string[]
): Record<string, DeviceFacts | undefined> =>
  Object.fromEntries(
    hostnames.map((hostname) => {
      const facts = read(files, factsKey(intentPath, hostname));
      return [hostname, facts && { ...facts, hostname }];
    })
  );

/** Facts older than this are read again when a page asks. */
export const factsMaxAgeMs = 24 * 60 * 60 * 1000;
/** After a failed read, a device is left alone this long. */
export const retryAfterMs = 10 * 60 * 1000;

export type ReadAttempt = { at: number; error: string };

/** A device's last failed read, while it is its last read: a dir of its own, as facts' is listed. */
const attemptKey = (intentPath: string, hostname: string): StoreKey<ReadAttempt> => ({
  path: `${stateLayout(intentPath).attempts}/${fileName(hostname)}.json`,
  schema: z.object({ at: z.number(), error: z.string() }),
  format: 1,
});

/** The last failed read of each of `hostnames`, if its last read failed. */
export const readFailures = (
  files: Pick<Platform, "readTextFile">,
  intentPath: string,
  hostnames: string[]
): Record<string, ReadAttempt | undefined> =>
  Object.fromEntries(hostnames.map((h) => [h, read(files, attemptKey(intentPath, h))]));

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

/** How old stored facts may grow before a read that learnt nothing new writes them again (only their age). */
const rewriteAfterMs = 3600_000;

/** Keep what was learnt while locating a device: where it is, its MACs and host key, its schema. */
export const rememberLocated = (files: StoreFiles, intentPath: string, located: Located, now: number) => {
  const facts: DeviceFacts = {
    hostname: located.hostname,
    readAt: now,
    schema: located.schema,
    address: located.address,
    macs: located.macs,
    ...(located.hostKey ? { hostKey: located.hostKey } : {}),
  };
  // Read every few seconds while a page shows status (a router keeps facts
  // in flash): written only when something changed, or to renew their age.
  const before = readFacts(files, intentPath, [located.hostname])[located.hostname];
  const same = before && JSON.stringify({ ...before, readAt: 0 }) === JSON.stringify({ ...before, ...facts, readAt: 0 });
  if (same && now - before.readAt < rewriteAfterMs) return;
  writeFacts(files, intentPath, facts);
};

/** A read that failed: the device is rested for a while (staleDevices). */
export const recordFailure = (files: StoreFiles, intentPath: string, hostname: string, attempt: ReadAttempt) =>
  write(files, attemptKey(intentPath, hostname), attempt);

/** A read that worked: any failure before it is forgotten. */
export const clearFailure = (files: Pick<Platform, "removeFile">, intentPath: string, hostname: string) =>
  remove(files, attemptKey(intentPath, hostname));

/**
 * The config with each device's address where it was found (src/locate.ts),
 * for an apply: a device that moved is applied where it is, and only once it
 * has shown it is that device. One not found keeps its configured address,
 * and the apply reports it as unreachable as before.
 */
export const withLocatedAddresses = async (plan: Plan, intentPath: string, platform: Platform) => {
  const { ready } = provisionableDevices(plan);
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
    plan: {
      ...plan,
      devices: plan.devices.map((d) =>
        addresses.has(d.hostname) ? { ...d, ipaddr: addresses.get(d.hostname)! } : d
      ),
    },
    hostKeys,
    unreached,
  };
};
