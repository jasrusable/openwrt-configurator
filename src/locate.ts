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
import { messageOf } from "./result";
import { leasesCommand } from "./status/device";
import type { DeviceFacts } from "./deviceFacts";
import { Probe, runProbes } from "./deviceProbes";
import { DeviceSchema } from "./deviceSchema";
import { deviceSchemaOf, deviceSchemaProbes } from "./getDeviceSchema";
import { where } from "./intent/places";
import { parseKnownHosts } from "./knownHosts";
import { PlanDevice } from "./plan/types";
import { Platform, Session } from "./platform";
import { ProvisionableDevice, sshConnectOptions } from "./apply/provisionConfig";
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
export const macsProbe: Probe<string[]> = {
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
  // Over IPv4, that address. Over IPv6 (the Mac resolved the name to its
  // global address), the device's own IPv4 instead: an IPv6 address from
  // DHCPv6 or SLAAC goes when an apply rebuilds the device's network, and
  // with it the apply's last reconnect (seen on a real access point).
  command:
    'set -- $SSH_CONNECTION; case "$3" in *:*) ip -4 -o addr show 2>/dev/null | awk \'$2 != "lo" {split($4, a, "/"); print a[1]; exit}\' ;; *) echo "$3" ;; esac',
  parse: ({ stdout }) => {
    const address = stdout.trim();
    // IPv4 only: never an address that could go mid-apply.
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(address) && isAddress(address) ? address : undefined;
  },
};

/** The router's DHCP leases and IPv4 neighbours: where to look for the rest, and what to offer adding. */
export type RouterTables = { leases: Lease[]; neighbours: Neighbour[] };
export const routerTables = {
  leases: { command: leasesCommand, parse: ({ stdout }) => parseLeases(stdout) } as Probe<Lease[]>,
  neighbours: { command: "ip -4 neigh show 2>/dev/null || true", parse: ({ stdout }) => parseNeighbours(stdout) } as Probe<Neighbour[]>,
};
const noTables = {
  leases: { command: "true", parse: () => [] } as Probe<Lease[]>,
  neighbours: { command: "true", parse: () => [] } as Probe<Neighbour[]>,
};

export type Located = {
  hostname: string;
  session: Session;
  address: string;
  schema: DeviceSchema;
  macs: string[];
  hostKey?: { type: string; key: string };
  /** The router's tables, read with the rest (the router only). */
  tables?: RouterTables;
};

export type NotLocated = { hostname: string; error: string };

type HostKey = { type: string; key: string };

/**
 * The key SSH trusted for `host` on first use, if any: in `file`, the one
 * known_hosts every client here records to and checks (dbclient's too, from
 * a home of its own), never the user's own ~/.ssh one.
 */
export const knownKey = (platform: Pick<Platform, "fileMode" | "readTextFile">, file: string, host: string): HostKey | undefined => {
  try {
    const text = platform.fileMode(file) === undefined ? "" : platform.readTextFile(file);
    const found = parseKnownHosts(text).find((k) => k.host === host);
    return found && { type: found.type, key: found.key };
  } catch {
    return undefined;
  }
};

/** An IPv4 or IPv6 address, not a name a DHCP client could claim. */
export const isAddress = (host: string) =>
  (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) && host.split(".").every((part) => Number(part) <= 255)) ||
  // IPv6: hex and colons only, at least two (nothing an ssh argument could start with).
  (/^[0-9a-f:]+$/i.test(host) && (host.match(/:/g) ?? []).length >= 2);

/**
 * Connect to `deviceConfig` at `address` only if it is that device: the
 * address pinned to its known host key first, its board checked once in.
 */
const tryAddress = async (
  deviceConfig: ProvisionableDevice,
  address: string,
  facts: DeviceFacts | undefined,
  pin: HostKey | undefined,
  platform: Platform,
  withTables: boolean
): Promise<Located> => {
  const at = { ...deviceConfig, ipaddr: address } as PlanDevice;
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
    // All in one round trip (a whole SSH client process under QuickJS).
    const read = await runProbes(session, {
      ...deviceSchemaProbes,
      macs: macsProbe,
      answeredOn,
      ...(withTables ? routerTables : noTables),
    });
    const schema = deviceSchemaOf(deviceConfig.hostname, read);
    if (facts && schema.name !== facts.schema.name) {
      throw new Error(`${address} is a ${schema.model ?? schema.name}, not ${deviceConfig.hostname}`);
    }
    // Its key: the pinned one, or the one just trusted on first use.
    const key = pin ?? knownKey(platform, file, address);
    return {
      hostname: deviceConfig.hostname,
      session,
      // Reached by name and its key on record: the address it answered on, so
      // the apply does not depend on the name; never what a device says of an
      // address we gave, nor without a key to hold the next connection to.
      address: !isAddress(address) && key && read.answeredOn ? read.answeredOn : address,
      schema,
      macs: read.macs,
      ...(key ? { hostKey: { type: key.type, key: key.key } } : {}),
      ...(withTables ? { tables: { leases: read.leases, neighbours: read.neighbours } } : {}),
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
  platform: Platform,
  withTables = false
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
        ? knownKey(platform, sshConnectOptions({ deviceConfig: deviceConfig as PlanDevice, platform }).knownHostsFile!, address)
        : undefined);
    if (!pin && !(configured && isAddress(address))) {
      failures.push(
        `${address} (${why}): not tried, no host key on record to check it against${configured ? `: add it in ${where("hardware", "Add")}` : ""}`
      );
      continue;
    }
    try {
      return await tryAddress(deviceConfig, address, facts, pin, platform, withTables);
    } catch (e) {
      failures.push(`${address} (${why}): ${messageOf(e)}`);
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
    ? locate(router, candidatesFor({ deviceConfig: router, facts: facts[router.hostname] }), facts[router.hostname], platform, true)
    : Promise.resolve(undefined);
  const tables = routerFound.then((found): RouterTables => (found && "session" in found && found.tables) || { leases: [], neighbours: [] });
  return devices.map((d) =>
    d === router
      ? (routerFound as Promise<Located | NotLocated>)
      : tables.then((t) => locate(d, candidatesFor({ deviceConfig: d, facts: facts[d.hostname], ...t }), facts[d.hostname], platform))
  );
};
