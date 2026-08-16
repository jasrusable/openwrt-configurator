import { NodeSSH } from "node-ssh";
import { getDeviceSchema } from "./getDeviceSchema";
import { getOpenWrtState } from "./getOpenWrtState";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { provisionOpenWrtDevice } from "./provisionOpenWrtDevice";

const connectTimeoutMs = 15000;

export const connectToDevice = async (deviceConfig: ONCDeviceConfig) => {
  const ssh = new NodeSSH();
  await ssh.connect({
    host: deviceConfig.ipaddr,
    username: deviceConfig.provisioning_config?.ssh_auth.username,
    password: deviceConfig.provisioning_config?.ssh_auth.password,
    // Without this an unreachable device hangs the whole run indefinitely.
    readyTimeout: connectTimeoutMs,
  });
  return ssh;
};

export const provisionConfig = async ({
  oncConfig,
  confirm = true,
  confirmTimeoutSeconds = 90,
}: {
  oncConfig: ONCConfig;
  confirm?: boolean;
  confirmTimeoutSeconds?: number;
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
      const ssh = await connectToDevice(deviceConfig);
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

  for (const { deviceConfig, deviceSchema, ssh } of ready) {
    const state = getOpenWrtState({ oncConfig, deviceConfig, deviceSchema });

    try {
      await provisionOpenWrtDevice({
        deviceModelId: deviceConfig.model_id,
        ipAddress: deviceConfig.ipaddr,
        hostname: deviceConfig.hostname,
        ssh,
        connect: () => connectToDevice(deviceConfig),
        state,
        confirm,
        confirmTimeoutSeconds,
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
