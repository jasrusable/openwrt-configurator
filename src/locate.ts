// Finding each device, and making sure it is that device. Settings say where
// a device should be (the router at its network's first address, the others
// at name.local-domain); a device that is not there yet (never applied,
// reset, renamed by DHCP) is looked for where it was last reached, then in
// the router's DHCP leases by name, then by MAC in the leases and neighbour
// table. No subnet is ever scanned.
//
// The app logs in as root, so a wrong guess must never reach another box.
// Before an address is tried for a device whose host key is known, the
// address is pinned to that key: any other machine there is refused by the
// usual host-key check; an address already pinned to another key is skipped.
// Once in, the board must be the one recorded. A device never reached before
// is trusted on first use at its configured address or leased name only, as
// before.
import type { DeviceFacts } from "./deviceFacts";
import { Probe, runProbes } from "./deviceProbes";
import { DeviceSchema } from "./deviceSchema";
import { getDeviceSchema } from "./getDeviceSchema";
import { checkHostKey, formatKnownHost, KnownHost, parseKnownHosts } from "./knownHosts";
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

export type Candidate = { address: string; why: string };

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
    ...(facts?.address ? [{ address: facts.address, why: "where it was last reached" }] : []),
    { address: deviceConfig.ipaddr, why: "where your settings put it" },
    ...leases.filter((l) => l.name === deviceConfig.hostname).map((l) => ({ address: l.address, why: "its name in the router's leases" })),
    ...leases.filter((l) => macs.has(l.mac)).map((l) => ({ address: l.address, why: "its MAC in the router's leases" })),
    ...neighbours.filter((n) => macs.has(n.mac)).map((n) => ({ address: n.address, why: "its MAC on the router's network" })),
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

const routerTables = {
  leases: { command: "cat /tmp/dhcp.leases 2>/dev/null || true", parse: ({ stdout }) => parseLeases(stdout) } as Probe<Lease[]>,
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

const knownHostsOf = (platform: Platform, file: string) => {
  try {
    return parseKnownHosts(platform.readTextFile(file));
  } catch {
    return [];
  }
};

/**
 * Connect to `deviceConfig` at `address` only if it is that device: the
 * address pinned to its known host key first, its board checked once in.
 */
const tryAddress = async (
  deviceConfig: ProvisionableDevice,
  address: string,
  facts: DeviceFacts | undefined,
  platform: Platform
): Promise<Located> => {
  const at = { ...deviceConfig, ipaddr: address } as ONCDeviceConfig;
  const file = sshConnectOptions({ deviceConfig: at, platform }).knownHostsFile!;
  if (facts?.hostKey) {
    const pin: KnownHost = { host: address, ...facts.hostKey };
    const seen = checkHostKey(knownHostsOf(platform, file), pin);
    if (seen === "changed") throw new Error(`${address} has another device's host key`);
    if (seen === "new") {
      const existing = (() => {
        try {
          return platform.readTextFile(file);
        } catch {
          return "";
        }
      })();
      platform.writeFileAtomic(file, existing + formatKnownHost(pin), 0o600);
    }
  }
  // A shorter handshake than an apply's: a wrong guess should give way quickly.
  const session = await platform.connect({
    ...sshConnectOptions({ deviceConfig: at, agentSocket: platform.env("SSH_AUTH_SOCK"), platform }),
    readyTimeout: attemptTimeoutMs,
  });
  try {
    const schema = await getDeviceSchema({ deviceConfig: at, ssh: session });
    if (facts && schema.name !== facts.schema.name) {
      throw new Error(`${address} is a ${schema.model ?? schema.name}, not ${deviceConfig.hostname}`);
    }
    const read = await runProbes(session, { macs });
    const key = knownHostsOf(platform, file).find((k) => k.host === address);
    return {
      hostname: deviceConfig.hostname,
      session,
      address,
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
  for (const { address, why } of candidates) {
    try {
      return await tryAddress(deviceConfig, address, facts, platform);
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
