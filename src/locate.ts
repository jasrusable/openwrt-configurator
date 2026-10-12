// Finding each device, and making sure it is that device. Settings say where
// a device should be (the router at its network's first address, the others
// at name.local-domain); a device that is not there yet (never applied,
// reset, renamed by DHCP) is looked for where it was last reached, then in
// the router's DHCP leases by name, then by MAC in the leases and neighbour
// table. No subnet is ever scanned.
//
// The app logs in as root, so a wrong guess must never reach another box,
// nor be handed a password. Only the address the settings give may be
// trusted on first use, and only when it is an address: a name (an access
// point's name.lan) is what DHCP says, and anyone can claim a name there. Any
// name, and any address the app found itself, is
// tried only for a device whose host key is on record, and the connection
// is held to that key by the SSH client itself (SshTarget.hostKey): any
// other machine there is refused before credentials are sent (dbclient,
// on a router, from a home of its own holding only that key). Once in, the
// board must be the one recorded.
import { leasesCommand } from "./status/device";
import type { DeviceFacts } from "./deviceFacts";
import { Probe, runProbes } from "./deviceProbes";
import { DeviceSchema } from "./deviceSchema";
import { getDeviceSchema } from "./getDeviceSchema";
import { where } from "./intent/places";
import { parseKnownHosts } from "./knownHosts";
import { ONCDeviceConfig } from "./oncConfigSchema";
import { Platform, Session } from "./platform";
import { ProvisionableDevice, sshConnectOptions } from "./provisionConfig";
import { Lease, parseLeases } from "./status/device";

export type Neighbour = { address: string; mac: string };

/** How long one address gets to answer before the next is tried. */
const attemptTimeoutMs = 4000;

/** `ip -4 neigh show`: "10.0.0.5 dev br-lan.1 lladdr aa:bb:cc:dd:ee:ff REACHABLE". */
export const parseNeighbours = (text: string): Neighbour[] =>
  text.split("\n").flatMap((line) => {
    const m = /^(\d+\.\d+\.\d+\.\d+)\s.*\blladdr\s+([0-9a-f:]{17})/i.exec(line.trim());
    return m ? [{ address: m[1], mac: m[2].toLowerCase() }] : [];
  });

export type Candidate = {
  address: string;
  why: string;
  /** From the settings: the one address that may be trusted on first use. Every other was found, and anyone can claim it. */
  configured: boolean;
};

/** Where to look for a device, best first, each address once. */
export const candidatesFor = ({
  deviceConfig,
  facts,
  leases = [],
  neighbours = [],
}: {
  deviceConfig: ProvisionableDevice;
  facts?: DeviceFacts;
  leases?: Lease[];
  neighbours?: Neighbour[];
}): Candidate[] => {
  const macs = new Set(facts?.macs ?? []);
  const all: Candidate[] = [
    ...(facts?.address ? [{ address: facts.address, why: "where it was last reached", configured: false }] : []),
    { address: deviceConfig.ipaddr, why: "where your settings put it", configured: true },
    ...leases
      .filter((l) => l.name === deviceConfig.hostname)
      .map((l) => ({ address: l.address, why: "its name in the router's leases", configured: false })),
    ...leases
      .filter((l) => macs.has(l.mac))
      .map((l) => ({ address: l.address, why: "its MAC in the router's leases", configured: false })),
    ...neighbours
      .filter((n) => macs.has(n.mac))
      .map((n) => ({ address: n.address, why: "its MAC on the router's network", configured: false })),
  ];
  return all.filter((c, i) => all.findIndex((d) => d.address === c.address) === i);
};

/** Every interface's MAC, so the device can be recognised in the router's leases. */
const macs: Probe<string[]> = {
  command: "cat /sys/class/net/*/address 2>/dev/null || true",
  parse: ({ stdout }) => [
    ...new Set(
      stdout
        .split("\n")
        .map((m) => m.trim().toLowerCase())
        .filter((m) => /^[0-9a-f:]{17}$/.test(m) && m !== "00:00:00:00:00:00")
    ),
  ],
};

/**
 * The address the device answered on, as dropbear tells the session
 * (SSH_CONNECTION: "client port server port"): a name (name.lan) is the
 * router's DHCP leases, which an apply can empty (dnsmasq restarted on a new
 * lease file), so what follows (the apply, its last reconnect) uses this.
 */
const answeredOn: Probe<string | undefined> = {
  command: 'echo "$SSH_CONNECTION"',
  parse: ({ stdout }) => {
    const server = stdout.trim().split(/\s+/)[2];
    return server && isAddress(server) ? server : undefined;
  },
};

const routerTables = {
  leases: { command: leasesCommand, parse: ({ stdout }) => parseLeases(stdout) } as Probe<Lease[]>,
  neighbours: { command: "ip -4 neigh show 2>/dev/null || true", parse: ({ stdout }) => parseNeighbours(stdout) } as Probe<Neighbour[]>,
};

export type Located = {
  hostname: string;
  session: Session;
  address: string;
  schema: DeviceSchema;
  macs: string[];
  hostKey?: { type: string; key: string };
};

export type NotLocated = { hostname: string; error: string };

/** The known_hosts file's text, empty when there is no file yet. */
const readKnownHosts = (platform: Platform, file: string) => {
  if (platform.fileMode(file) === undefined) return "";
  return platform.readTextFile(file);
};

type HostKey = { type: string; key: string };

/**
 * The key SSH trusted for `host` on first use, if any: in the shared
 * known_hosts (Node, OpenSSH), else in dbclient's own ~/.ssh/known_hosts
 * (on a router, which cannot be pointed at another file).
 */
export const knownKey = (platform: Platform, file: string, host: string): HostKey | undefined => {
  for (const path of [file, `${platform.homedir()}/.ssh/known_hosts`]) {
    try {
      const found = parseKnownHosts(readKnownHosts(platform, path)).find((k) => k.host === host);
      if (found) return { type: found.type, key: found.key };
    } catch {
      // Unreadable: try the next.
    }
  }
  return undefined;
};

/** An IPv4 or IPv6 address, not a name a DHCP client could claim. */
export const isAddress = (host: string) => /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":");

/**
 * Connect to `deviceConfig` at `address` only if it is that device: the
 * address pinned to its known host key first, its board checked once in.
 */
const tryAddress = async (
  deviceConfig: ProvisionableDevice,
  address: string,
  facts: DeviceFacts | undefined,
  pin: HostKey | undefined,
  platform: Platform
): Promise<Located> => {
  const at = { ...deviceConfig, ipaddr: address } as ONCDeviceConfig;
  const file = sshConnectOptions({ deviceConfig: at, platform }).knownHostsFile!;
  // A shorter handshake than an apply's: a wrong guess should give way quickly.
  // A known device is held to its recorded key, by the SSH client itself:
  // another machine at this address is refused before credentials are sent.
  const session = await platform.connect({
    ...sshConnectOptions({ deviceConfig: at, agentSocket: platform.env("SSH_AUTH_SOCK"), platform }),
    readyTimeout: attemptTimeoutMs,
    ...(pin ? { hostKey: pin } : {}),
  });
  try {
    const schema = await getDeviceSchema({ deviceConfig: at, ssh: session });
    if (facts && schema.name !== facts.schema.name) {
      throw new Error(`${address} is a ${schema.model ?? schema.name}, not ${deviceConfig.hostname}`);
    }
    const read = await runProbes(session, { macs, answeredOn });
    // Its key: the pinned one, or the one just trusted on first use.
    const key = pin ?? knownKey(platform, file, address);
    return {
      hostname: deviceConfig.hostname,
      session,
      // An address, never a name, once it has answered: held to its key all the same.
      address: read.answeredOn ?? address,
      schema,
      macs: read.macs,
      ...(key ? { hostKey: { type: key.type, key: key.key } } : {}),
    };
  } catch (e) {
    session.dispose();
    throw e;
  }
};

/** Find one device among its candidates, best first. */
const locate = async (
  deviceConfig: ProvisionableDevice,
  candidates: Candidate[],
  facts: DeviceFacts | undefined,
  platform: Platform
): Promise<Located | NotLocated> => {
  const failures: string[] = [];
  for (const { address, why, configured } of candidates) {
    // Fail closed: an address the app found (a lease, a MAC, the last one)
    // could be anyone's. It is tried only pinned to the device's recorded
    // host key, which both SSH clients check before any credential is sent.
    // A name in the settings is the router's DNS answering from DHCP: held
    // to the key on record, else to the one SSH already trusts for the name.
    const pin =
      facts?.hostKey ??
      (configured && !isAddress(address)
        ? knownKey(platform, sshConnectOptions({ deviceConfig: deviceConfig as ONCDeviceConfig, platform }).knownHostsFile!, address)
        : undefined);
    if (!pin && !(configured && isAddress(address))) {
      failures.push(
        `${address} (${why}): not tried, no host key on record to check it against${configured ? `: add it in ${where("hardware", "Add")}` : ""}`
      );
      continue;
    }
    try {
      return await tryAddress(deviceConfig, address, facts, pin, platform);
    } catch (e) {
      failures.push(`${address} (${why}): ${(e as Error).message}`);
    }
  }
  return { hostname: deviceConfig.hostname, error: failures.join("; ") || "nowhere to look" };
};

/**
 * Find every device: one promise each, in `devices` order. The router is
 * found first, and its leases and neighbours then help find the rest. Each
 * found device's session is its caller's to dispose, even one that arrives
 * after the caller stopped waiting.
 */
export const locateEach = ({
  devices,
  facts,
  platform,
}: {
  devices: ProvisionableDevice[];
  facts: Record<string, DeviceFacts | undefined>;
  platform: Platform;
}): Promise<Located | NotLocated>[] => {
  const router = devices.find((d) => d.tags?.role === "router");
  const routerFound = router
    ? locate(router, candidatesFor({ deviceConfig: router, facts: facts[router.hostname] }), facts[router.hostname], platform)
    : Promise.resolve(undefined);
  const tables = routerFound.then((found) =>
    found && "session" in found
      ? runProbes(found.session, routerTables).catch(() => ({ leases: [], neighbours: [] }))
      : { leases: [] as Lease[], neighbours: [] as Neighbour[] }
  );
  // The router is handed over only once its tables are read, so its caller
  // cannot close the session under that read.
  const routerReady = tables.then(() => routerFound) as Promise<Located | NotLocated>;
  return devices.map((d) =>
    d === router
      ? routerReady
      : tables.then((t) => locate(d, candidatesFor({ deviceConfig: d, facts: facts[d.hostname], ...t }), facts[d.hostname], platform))
  );
};
