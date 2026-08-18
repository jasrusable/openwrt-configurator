import { homedir } from "os";
import { join } from "path";
import { NodeSSH } from "node-ssh";
import { getDeviceSchema } from "./getDeviceSchema";
import { getOpenWrtState } from "./getOpenWrtState";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import {
  provisionOpenWrtDevice,
  RollbackMode,
} from "./provisionOpenWrtDevice";

const connectTimeoutMs = 15000;

const expandHome = (path: string) =>
  path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

export const sshConnectOptions = ({
  deviceConfig,
  identityPath,
  agentSocket,
}: {
  deviceConfig: ONCDeviceConfig;
  identityPath?: string;
  agentSocket?: string;
}) => {
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
    ...(keyPath ? { privateKeyPath: expandHome(keyPath) } : {}),
    ...(password ? { password } : {}),
    ...(!keyPath && !password && agentSocket ? { agent: agentSocket } : {}),
  };
};

export const connectToDevice = async (
  deviceConfig: ONCDeviceConfig,
  options?: { identityPath?: string }
) => {
  const ssh = new NodeSSH();
  await ssh.connect(
    sshConnectOptions({
      deviceConfig,
      identityPath: options?.identityPath,
      agentSocket: process.env.SSH_AUTH_SOCK,
    })
  );

  // Once a command is in flight node-ssh drops its own 'error' listener, so an
  // RST arriving mid-command would emit 'error' with nothing attached and kill
  // the process. The command still settles via the channel closing.
  ssh.connection?.on("error", () => {});

  return ssh;
};

export const provisionConfig = async ({
  oncConfig,
  confirm = true,
  confirmTimeoutSeconds = 90,
  rollbackMode = "reload-then-reboot",
  identityPath,
}: {
  oncConfig: ONCConfig;
  confirm?: boolean;
  confirmTimeoutSeconds?: number;
  rollbackMode?: RollbackMode;
  identityPath?: string;
}) => {
  const deviceConfigs = oncConfig.devices.filter(
    (device) =>
      device.enabled !== false &&
      device.ipaddr &&
      device.provisioning_config?.ssh_auth
  );

  // One session per device, opened once and reused for introspection and
  // provisioning. Previously each device was connected to twice and neither
  // session was ever disposed.
  const connections = await Promise.allSettled(
    deviceConfigs.map(async (deviceConfig) => {
      const ssh = await connectToDevice(deviceConfig, { identityPath });
      try {
        const deviceSchema = await getDeviceSchema({ deviceConfig, ssh });
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

  for (const { deviceConfig, deviceSchema, ssh: introspected } of ready) {
    const state = getOpenWrtState({ oncConfig, deviceConfig, deviceSchema });

    // Sessions are opened for every device up front so the run can abort before
    // changing anything. By the time this device's turn comes, an earlier
    // device's network changes may have killed its session — an AP behind a
    // freshly reconfigured router is the obvious case. Check, and reconnect if
    // it has gone, rather than provisioning over a stale session.
    let ssh = introspected;
    const alive = await introspected
      .execCommand("true")
      .then((r) => r.code === 0)
      .catch(() => false);
    if (!alive) {
      console.log(
        `Session to ${deviceConfig.hostname} did not survive; reconnecting...`
      );
      try {
        introspected.dispose();
      } catch {
        // Already gone.
      }
      ssh = await connectToDevice(deviceConfig, { identityPath });
    }

    try {
      await provisionOpenWrtDevice({
        deviceModelId: deviceConfig.model_id,
        ipAddress: deviceConfig.ipaddr,
        hostname: deviceConfig.hostname,
        ssh,
        connect: () => connectToDevice(deviceConfig, { identityPath }),
        state,
        confirm,
        confirmTimeoutSeconds,
        rollbackMode,
      });
    } finally {
      try {
        ssh.dispose();
      } catch {
        // Already disposed after the commit; nothing to clean up.
      }
    }
  }
};
