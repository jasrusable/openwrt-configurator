import { DeviceSchema } from "./deviceSchema";
import { getOpenWRTConfig } from "./getOpenWRTConfig";
import { ONCConfig } from "./oncConfigSchema";
import { provisionOpenWRTDevice } from "./provisionOpenWRTDevice";

export const provisionConfig = async ({
  oncConfig,
  deviceSchemas,
}: {
  oncConfig: ONCConfig;
  deviceSchemas: DeviceSchema[];
}) => {
  const enabledDeviceConfigs = oncConfig.devices.filter(
    (device) => device.enabled !== false
  );

  for (const deviceConfig of enabledDeviceConfigs) {
    if (deviceConfig.ipaddr && deviceConfig.provisioning_config?.ssh_auth) {
      const deviceSchema = deviceSchemas.find(
        (schema) => schema.name === deviceConfig.deviceModelId
      );
      if (!deviceSchema) {
        throw new Error(
          `Device schema not found for device model: ${deviceConfig.deviceModelId}`
        );
      }

      const openWRTConfig = getOpenWRTConfig({
        oncConfig,
        deviceConfig,
        deviceSchema,
      });

      await provisionOpenWRTDevice({
        deviceId: deviceConfig.deviceModelId,
        deviceVersion: deviceConfig.version,
        ipAddress: deviceConfig.ipaddr,
        auth: deviceConfig.provisioning_config.ssh_auth,
        openWRTConfig,
      });
    }
  }
};
