import { DeviceSchema } from "./deviceSchema";
import { getOpenWrtConfig } from "./getOpenWrtConfig";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { OpenWrtState } from "./openWrtConfigSchema";
import { conditionMatches } from "./resolveOncConfig";

export const getOpenWrtState = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const openWrtConfig = getOpenWrtConfig({
    oncConfig,
    deviceConfig,
    deviceSchema,
  });

  const packages = (oncConfig.package_profiles || [])
    .filter((packageProfile) => {
      return conditionMatches({
        condition: packageProfile[".condition"],
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

  const a = deviceSchema.config_sections || {};

  const configsToIgnore = (oncConfig.configs_to_ignore || [])
    .filter((a) => {
      return conditionMatches({
        condition: a[".condition"],
        deviceConfig,
        deviceSchema,
      });
    })
    .reduce<string[]>((acc, curr) => {
      return [...acc, ...curr.configs];
    }, []);

  const configSectionsToReset = Object.keys(a).reduce((acc, configKey) => {
    if (configsToIgnore.includes(`${configKey}.*`)) {
      return acc;
    }
    const sectionKeys = a[configKey].filter((sectionKey) => {
      return !configsToIgnore.includes(`${configKey}.${sectionKey}`);
    });
    return { ...acc, [configKey]: [...(acc[configKey] || []), ...sectionKeys] };
  }, {} as any);

  const openWrtState: OpenWrtState = {
    config: openWrtConfig,
    packagesToInstall,
    packagesToUninstall,
    configSectionsToReset,
  };

  return openWrtState;
};
