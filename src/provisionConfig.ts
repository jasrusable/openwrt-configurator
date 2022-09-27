import { DeviceSchema } from "./deviceSchema";
import { getOpenWrtConfig } from "./getOpenWrtConfig";
import { ONCConfig } from "./oncConfigSchema";
import { provisionOpenWRTDevice } from "./provisionOpenWrtDevice";

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
        (schema) => schema.name === deviceConfig.model_id
      );
      if (!deviceSchema) {
        throw new Error(
          `Device schema not found for device model: ${deviceConfig.model_id}`
        );
      }

      const openWRTConfig = getOpenWrtConfig({
        oncConfig,
        deviceConfig,
        deviceSchema,
      });

      await provisionOpenWRTDevice({
        deviceId: deviceConfig.model_id,
        deviceVersion: deviceConfig.version,
        ipAddress: deviceConfig.ipaddr,
        auth: deviceConfig.provisioning_config.ssh_auth,
        openWrtConfig: openWRTConfig,
      });
    }
  }
};
