import { DeviceSchema } from "./deviceSchema";
import { getOpenWrtConfig } from "./getOpenWrtConfig";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { targetMatches } from "./resolveOncConfig";

export const getOpenWrtState = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const config = getOpenWrtConfig({ oncConfig, deviceConfig, deviceSchema });

  const packages = (oncConfig.package_profiles || [])
    .filter((packageProfile) => {
      return targetMatches({
        target: packageProfile.target,
        deviceConfig,
        deviceSchema,
      });
    })
    .reduce<string[]>((acc, packageProfile) => {
      return [...new Set([...acc, ...packageProfile.packages])];
    }, []);

  return { config, packages };
};
