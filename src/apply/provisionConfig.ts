import { Reporter } from "../applyEvents";
import { assertSupportedRelease } from "../release";
import { DeviceSchema } from "../deviceSchema";
import { getDeviceSchema } from "../getDeviceSchema";
import { getOpenWrtState } from "../engine/getOpenWrtState";
import { Plan, PlanDevice } from "../plan/types";
import { OpenWrtState } from "../engine/openWrtState";
import { join } from "../posixPath";
import { Platform, Session, SshTarget } from "../platform";
import { messageOf } from "../result";
import { runProbe, wifiStations } from "../deviceProbes";
import { meshDepths, meshView } from "./meshOrder";
import { defaultGateway, ownMacs } from "./gateway";
import { provisionNetwork, provisioningOrder } from "./provisionNetwork";
import { RollbackMode } from "../agent";
import { ConfirmTiming, confirmTiming } from "./reconnect";

const connectTimeoutMs = 15000;

export const expandHome = (path: string, home: string) =>
  path === "~"
    ? home
    : path.startsWith("~/")
    ? join(home, path.slice(2))
    : path;

export const isPublicKeyPath = (path: string) => path.endsWith(".pub");

// ssh2 reads no ssh_config, so an agent set there (1Password's IdentityAgent)
// would be missed: asked of OpenSSH itself, once per host, else SSH_AUTH_SOCK.
const agents = new Map<string, Promise<string | undefined>>();
export const agentSocketFor = (host: string, platform: Pick<Platform, "run" | "env" | "homedir">) => {
  const known = agents.get(host);
  if (known) return known;
  const found = platform
    .run(["ssh", "-G", "--", host], { timeoutMs: 5_000 })
    .then((r) => (r.code === 0 ? /^identityagent (.+)$/m.exec(r.stdout)?.[1].trim().replace(/^"(.*)"$/, "$1") : undefined))
    .catch(() => undefined)
    .then((agent) =>
      !agent || agent === "SSH_AUTH_SOCK"
        ? platform.env("SSH_AUTH_SOCK")
        : agent === "none"
          ? undefined
          : expandHome(agent, platform.homedir())
    );
  agents.set(host, found);
  return found;
};

/** The agent to log in with, when no private key file does: none is looked for otherwise. */
export const agentSocketOf = ({
  deviceConfig,
  identityPath,
  platform,
}: {
  deviceConfig: PlanDevice;
  identityPath?: string;
  platform: Pick<Platform, "run" | "env" | "homedir">;
}) => {
  const named = identityPath || deviceConfig.login?.privateKeyPath;
  return named && !isPublicKeyPath(named) ? Promise.resolve(undefined) : agentSocketFor(deviceConfig.ipaddr ?? "", platform);
};

export const sshConnectOptions = ({
  deviceConfig,
  identityPath,
  agentSocket,
  platform,
}: {
  deviceConfig: PlanDevice;
  identityPath?: string;
  agentSocket?: string;
  platform: Pick<Platform, "env" | "homedir">;
}): SshTarget => {
  const auth = deviceConfig.login;
  const named = identityPath || auth?.privateKeyPath;
  // A public key names the agent's (1Password's): its private half is not on disk.
  const keyPath = named && !isPublicKeyPath(named) ? named : undefined;
  const password = auth?.password;

  return {
    host: deviceConfig.ipaddr,
    username: auth?.username,
    // readyTimeout only covers the handshake. Committing network config can
    // blackhole the socket mid-command, and with no keepalive that hangs until
    // the kernel gives up (~13 minutes) — long past the rollback window, so the
    // device would reboot while we waited. Keepalives surface it in ~15s.
    readyTimeout: connectTimeoutMs,
    keepaliveInterval: 5000,
    keepaliveCountMax: 3,
    ...(keyPath
      ? { privateKeyPath: expandHome(keyPath, platform.homedir()) }
      : {}),
    ...(password ? { password } : {}),
    // Beside a password too: ssh2 tries the password first, then the agent,
    // so a device with password login off still lets the agent's key in.
    ...(!keyPath && agentSocket ? { agent: agentSocket } : {}),
    // Set but empty is unset: never no file, which would check no key.
    knownHostsFile:
      platform.env("ONC_KNOWN_HOSTS") ||
      join(platform.homedir(), ".config/openwrt-configurator/known_hosts"),
  };
};

export const connectToDevice = async ({
  deviceConfig,
  identityPath,
  hostKey,
  platform,
}: {
  deviceConfig: PlanDevice;
  identityPath?: string;
  /** Held to this key by the SSH client itself (an address found by src/locate.ts). */
  hostKey?: { type: string; key: string };
  platform: Platform;
}) =>
  platform.connect({
    ...sshConnectOptions({
      deviceConfig,
      identityPath,
      agentSocket: await agentSocketOf({ deviceConfig, identityPath, platform }),
      platform,
    }),
    ...(hostKey ? { hostKey } : {}),
  });

/**
 * Connections that follow a device, as it can move while it is applied (its
 * lease renewed at commit): where it last answered, then where it was found,
 * then its other addresses, these only held to the key it was found by,
 * which the SSH client checks before any credential is sent.
 */
export const following = ({
  hostKeys,
  alsoAt,
  connectAt,
  log = console.log,
}: {
  hostKeys: Record<string, { type: string; key: string }>;
  alsoAt: Record<string, string[]>;
  connectAt: (deviceConfig: PlanDevice, hostKey?: { type: string; key: string }) => Promise<Session>;
  log?: (line: string) => void;
}) => {
  const lastAt = new Map<string, string>();
  return async (deviceConfig: PlanDevice): Promise<Session> => {
    const { hostname } = deviceConfig;
    const hostKey = hostKeys[hostname];
    const found = deviceConfig.ipaddr!;
    const addresses = [...new Set([lastAt.get(hostname) ?? found, found, ...(hostKey ? alsoAt[hostname] ?? [] : [])])];
    // Each address's failure is said: a changed key at the next one is the
    // one that matters.
    const attempt = async ([address, ...rest]: string[], failed: string[]): Promise<Session> => {
      try {
        const session = await connectAt({ ...deviceConfig, ipaddr: address }, hostKey);
        if (address !== (lastAt.get(hostname) ?? found)) log(`${hostname}: now answering at ${address}.`);
        lastAt.set(hostname, address);
        return session;
      } catch (e) {
        const all = [...failed, addresses.length > 1 ? `${address}: ${messageOf(e)}` : messageOf(e)];
        if (!rest.length) throw failed.length ? new Error(all.join("; ")) : e;
        return attempt(rest, all);
      }
    };
    return attempt(addresses, []);
  };
};

export type ProvisionableDevice = PlanDevice & {
  ipaddr: string;
  login: NonNullable<PlanDevice["login"]>;
};

/**
 * The enabled devices that can be reached over SSH, and why the others cannot.
 * A device without an address or SSH login is legitimate — one that is only
 * ever built as an image, say — so it is skipped with a note, not an error.
 */
export const provisionableDevices = (plan: Plan) =>
  plan.devices
    .filter((device) => device.enabled !== false)
    .reduce<{
      ready: ProvisionableDevice[];
      skipped: { hostname: string; reason: string }[];
    }>(
      ({ ready, skipped }, device) =>
        !device.ipaddr
          ? {
              ready,
              skipped: [
                ...skipped,
                { hostname: device.hostname, reason: "no ipaddr" },
              ],
            }
          : !device.login
          ? {
              ready,
              skipped: [
                ...skipped,
                {
                  hostname: device.hostname,
                  reason: "no provisioning_config.ssh_auth",
                },
              ],
            }
          : { ready: [...ready, device as ProvisionableDevice], skipped },
      { ready: [], skipped: [] }
    );

export const reportSkipped = (
  skipped: { hostname: string; reason: string }[]
) =>
  skipped.forEach(({ hostname, reason }) =>
    console.warn(`Skipping ${hostname}: ${reason}.`)
  );

/**
 * With several mesh nodes (a batman interface in their config), how deep
 * each is, from what the nodes report now (src/meshOrder.ts). Cabled nodes
 * are those the config does not ask to go early. Read-only.
 */
const meshDepthsOf = async (
  ready: { deviceConfig: PlanDevice; state: OpenWrtState; ssh: Session }[]
): Promise<Record<string, number>> => {
  const nodes = ready.filter(({ state }) =>
    (state.config.network?.interface ?? []).some((i: { ".name": string }) => i[".name"] === "bat0")
  );
  if (nodes.length < 2) return {};
  const views = Object.fromEntries(
    await Promise.all(
      nodes.map(async ({ deviceConfig, ssh }) => [deviceConfig.hostname, await runProbe(ssh, meshView)] as const)
    )
  );
  const cabled = nodes.filter((n) => (n.deviceConfig.provisionOrder ?? 0) >= 0).map((n) => n.deviceConfig.hostname);
  return meshDepths({ views, cabled });
};

/**
 * The devices this machine reaches the network through by Wi-Fi: one whose
 * Wi-Fi clients include one of its MACs. Applied after the rest, as changing
 * it first could cut this machine off from the devices after it. Read-only.
 */
const accessPointsOf = async (
  platform: Pick<Platform, "os" | "run">,
  ready: { deviceConfig: PlanDevice; ssh: Session }[]
): Promise<string[]> => {
  const mine = await ownMacs(platform);
  if (mine.length === 0) return [];
  const seen = await Promise.all(
    ready
      .filter(({ ssh }) => !ssh.local)
      .map(async ({ deviceConfig, ssh }) => ({
        hostname: deviceConfig.hostname,
        stations: await runProbe(ssh, wifiStations).catch(() => [] as string[]),
      }))
  );
  return seen.filter(({ stations }) => stations.some((mac) => mine.includes(mac))).map(({ hostname }) => hostname);
};

export const provisionConfig = async ({
  plan,
  confirm = true,
  confirmTimeoutSeconds = 90,
  rollbackMode = "reload-then-reboot",
  identityPath,
  platform,
  timing,
  onDeviceSchema,
  hostKeys = {},
  alsoAt = {},
  report,
  verify,
}: {
  /** Per hostname: the state hash its reviewed plan was read from (src/applyPlan.ts); a device that differs, or is not in it, stops the run before anything is armed. */
  verify?: Record<string, string>;
  /** Where each device is, and how the run ended, as data (applyEvents.ts). */
  report?: Reporter;
  plan: Plan;
  /** Per hostname: the key its address was found by, which every connection to it must show. */
  hostKeys?: Record<string, { type: string; key: string }>;
  /** Per hostname: other addresses it may answer at (its configured name), tried only held to its host key. */
  alsoAt?: Record<string, string[]>;
  /** Told each device's schema as it is read: an apply keeps the device facts fresh. */
  onDeviceSchema?: (hostname: string, schema: DeviceSchema) => void;
  confirm?: boolean;
  confirmTimeoutSeconds?: number;
  rollbackMode?: RollbackMode;
  identityPath?: string;
  platform: Platform;
  timing?: ConfirmTiming;
}) => {
  const connect = following({
    hostKeys,
    alsoAt,
    connectAt: (deviceConfig, hostKey) => connectToDevice({ deviceConfig, identityPath, hostKey, platform }),
  });

  const { ready: deviceConfigs, skipped } = provisionableDevices(plan);
  reportSkipped(skipped);

  // One session per device, opened once and reused for introspection and
  // provisioning. Previously each device was connected to twice and neither
  // session was ever disposed.
  const connections = await Promise.allSettled(
    deviceConfigs.map(async (deviceConfig) => {
      const ssh = await connect(deviceConfig);
      try {
        const deviceSchema = await getDeviceSchema({ deviceConfig, ssh });
        onDeviceSchema?.(deviceConfig.hostname, deviceSchema);
        assertSupportedRelease(deviceConfig.hostname, deviceSchema.version);
        // Paired with its own device. Looking the schema up by model_id meant
        // two devices of the same model shared whichever schema was built
        // first, so the second got the other's config_sections and version.
        return { deviceConfig, deviceSchema, ssh };
      } catch (e) {
        ssh.dispose();
        throw e;
      }
    })
  );

  const ready = connections.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []
  );
  const failures = connections.flatMap((result, index) =>
    result.status === "rejected"
      ? [{ deviceConfig: deviceConfigs[index], reason: result.reason }]
      : []
  );

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(
        `Failed to inspect ${failure.deviceConfig.hostname} @ ${failure.deviceConfig.ipaddr}: ` +
          `${(failure.reason as Error)?.message ?? failure.reason}`
      );
    }
    // Abort before changing anything: a config describes the network as a
    // whole, so provisioning a subset risks an inconsistent network. Use
    // `"enabled": false` to intentionally skip a device.
    for (const { ssh } of ready) {
      ssh.dispose();
    }
    throw new Error(
      `Aborting: ${failures.length} of ${deviceConfigs.length} device(s) could not be inspected. No device was changed.`
    );
  }

  const planned = ready.map((device) => ({ ...device, state: getOpenWrtState({ plan, ...device }) }));
  const depths = await meshDepthsOf(planned);
  const devices = provisioningOrder(
    planned.map(({ deviceConfig, state, ssh }) => ({
      deviceModelId: deviceConfig.modelId,
      ipAddress: deviceConfig.ipaddr,
      hostname: deviceConfig.hostname,
      // Deepest in the mesh first, as measured; cabled nodes (depth 0) and
      // those not measured keep the config's order.
      order: depths[deviceConfig.hostname] ? -depths[deviceConfig.hostname] : deviceConfig.provisionOrder,
      ssh,
      connect: () => connect(deviceConfig),
      state,
      rollbackMode,
      recoverSeconds: 60,
      sleep: platform.sleep,
      now: Date.now,
      timing: timing ?? confirmTiming(),
      report,
      ...(verify ? { verify: { hash: verify[deviceConfig.hostname], sha256: platform.sha256 } } : {}),
    })),
    await defaultGateway(platform),
    await accessPointsOf(platform, planned)
  );
  console.log(
    `Provisioning ${devices.map((d) => d.hostname).join(", then ")}` +
      (confirm && devices.length > 1
        ? ", as one change: all are confirmed or all roll back."
        : ".")
  );
  try {
    return await provisionNetwork({ devices, confirm, confirmTimeoutSeconds, report });
  } finally {
    devices.forEach((device) => {
      try {
        device.ssh.dispose();
      } catch {
        // Already closed.
      }
    });
  }
};
