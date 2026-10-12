import { assertSupportedRelease } from "./release";
import { DeviceSchema } from "./deviceSchema";
import { getDeviceSchema } from "./getDeviceSchema";
import { getOpenWrtState } from "./getOpenWrtState";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { join } from "./paths";
import { Platform, SshTarget } from "./platform";
import { defaultGateway } from "./gateway";
import { provisionNetwork, provisioningOrder } from "./provisionNetwork";
import { RollbackMode } from "./rollback";
import { ConfirmTiming, confirmTiming } from "./confirm";

const connectTimeoutMs = 15000;

const expandHome = (path: string, home: string) =>
  path === "~"
    ? home
    : path.startsWith("~/")
    ? join(home, path.slice(2))
    : path;

export const sshConnectOptions = ({
  deviceConfig,
  identityPath,
  agentSocket,
  platform,
}: {
  deviceConfig: ONCDeviceConfig;
  identityPath?: string;
  agentSocket?: string;
  platform: Pick<Platform, "env" | "homedir">;
}): SshTarget => {
  const auth = deviceConfig.provisioning_config?.ssh_auth;
  const keyPath = identityPath || auth?.private_key_path;
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
    ...(!keyPath && !password && agentSocket ? { agent: agentSocket } : {}),
    knownHostsFile:
      platform.env("ONC_KNOWN_HOSTS") ??
      join(platform.homedir(), ".config/openwrt-configurator/known_hosts"),
  };
};

export const connectToDevice = ({
  deviceConfig,
  identityPath,
  platform,
}: {
  deviceConfig: ONCDeviceConfig;
  identityPath?: string;
  platform: Platform;
}) =>
  platform.connect(
    sshConnectOptions({
      deviceConfig,
      identityPath,
      agentSocket: platform.env("SSH_AUTH_SOCK"),
      platform,
    })
  );

export type ProvisionableDevice = ONCDeviceConfig & {
  ipaddr: string;
  provisioning_config: NonNullable<ONCDeviceConfig["provisioning_config"]>;
};

/**
 * The enabled devices that can be reached over SSH, and why the others cannot.
 * A device without an address or SSH login is legitimate — one that is only
 * ever built as an image, say — so it is skipped with a note, not an error.
 */
export const provisionableDevices = (oncConfig: ONCConfig) =>
  oncConfig.devices
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
          : !device.provisioning_config?.ssh_auth
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

export const provisionConfig = async ({
  oncConfig,
  confirm = true,
  confirmTimeoutSeconds = 90,
  rollbackMode = "reload-then-reboot",
  identityPath,
  platform,
  timing,
  onDeviceSchema,
}: {
  oncConfig: ONCConfig;
  /** Told each device's schema as it is read: an apply keeps the device facts fresh. */
  onDeviceSchema?: (hostname: string, schema: DeviceSchema) => void;
  confirm?: boolean;
  confirmTimeoutSeconds?: number;
  rollbackMode?: RollbackMode;
  identityPath?: string;
  platform: Platform;
  timing?: ConfirmTiming;
}) => {
  const connect = (deviceConfig: ONCDeviceConfig) =>
    connectToDevice({ deviceConfig, identityPath, platform });

  const { ready: deviceConfigs, skipped } = provisionableDevices(oncConfig);
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

  const devices = provisioningOrder(
    ready.map(({ deviceConfig, deviceSchema, ssh }) => ({
      deviceModelId: deviceConfig.model_id,
      ipAddress: deviceConfig.ipaddr,
      hostname: deviceConfig.hostname,
      ssh,
      connect: () => connect(deviceConfig),
      state: getOpenWrtState({ oncConfig, deviceConfig, deviceSchema }),
      rollbackMode,
      recoverSeconds: 60,
      sleep: platform.sleep,
      now: Date.now,
      timing: timing ?? confirmTiming(),
    })),
    await defaultGateway(platform)
  );
  console.log(
    `Provisioning ${devices.map((d) => d.hostname).join(", then ")}` +
      (confirm && devices.length > 1
        ? ", as one change: all are confirmed or all roll back."
        : ".")
  );
  try {
    await provisionNetwork({ devices, confirm, confirmTimeoutSeconds });
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
