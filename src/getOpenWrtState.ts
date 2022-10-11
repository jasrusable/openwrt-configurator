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

  const packagesToInstall = packages
    .filter((packageName) => !packageName.startsWith("-"))
    .map((packageLine) => {
      const [packageName, version] = packageLine.split("@");
      return {
        packageName,
        version,
      };
    });

  const packagesToUninstall = packages
    .filter((packageName) => packageName.startsWith("-"))
    .map((name) => name.slice(1));

  return { config, packagesToInstall, packagesToUninstall };
};
