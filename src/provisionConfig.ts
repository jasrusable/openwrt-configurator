import { getDeviceSchema } from "./getDeviceSchema";
import { getOpenWrtConfig } from "./getOpenWrtConfig";
import { getOpenWrtState } from "./getOpenWrtState";
import { ONCConfig } from "./oncConfigSchema";
import { provisionOpenWrtDevice } from "./provisionOpenWrtDevice";

export const provisionConfig = async ({
  oncConfig,
}: {
  oncConfig: ONCConfig;
}) => {
  const deviceConfigs = oncConfig.devices.filter(
    (device) => device.enabled !== false
  );

  const deviceSchemas = await Promise.all(
    deviceConfigs.map(async (deviceConfig) => {
      const deviceSchema = await getDeviceSchema({ deviceConfig });
      return deviceSchema;
    })
  );

  for (const deviceConfig of deviceConfigs) {
    if (deviceConfig.ipaddr && deviceConfig.provisioning_config?.ssh_auth) {
      const deviceSchema = deviceSchemas.find(
        (schema) => schema.name === deviceConfig.model_id
      );
      if (!deviceSchema) {
        throw new Error(
          `Device schema not found for device: ${deviceConfig.model_id}@${deviceConfig.ipaddr}`
        );
      }

      const state = getOpenWrtState({
        oncConfig,
        deviceConfig,
        deviceSchema,
      });

      await provisionOpenWrtDevice({
        deviceModelId: deviceConfig.model_id,
        ipAddress: deviceConfig.ipaddr,
        auth: deviceConfig.provisioning_config.ssh_auth,
        state,
      });
    }
  }
};
