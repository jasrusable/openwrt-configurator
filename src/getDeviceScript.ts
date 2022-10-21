import { dhcpSectionsToReset } from "./configSchemas/dhcp";
import { firewallSectionsToReset } from "./configSchemas/firewall";
import { networkSectionsToReset } from "./configSchemas/network";
import { systemSectionsToReset } from "./configSchemas/system";
import { wirelessSectionsToReset } from "./configSchemas/wireless";
import { DeviceSchema } from "./deviceSchema";
import { getUciCommands } from "./getUciCommands";
import { OpenWrtConfig, OpenWrtState } from "./openWrtConfigSchema";

const sectionsToReset: any = {
  ...dhcpSectionsToReset,
  ...firewallSectionsToReset,
  ...networkSectionsToReset,
  ...systemSectionsToReset,
  ...wirelessSectionsToReset,
};

const configSectionMapping = Object.keys(sectionsToReset).reduce<any[]>(
  (acc, configKey) => {
    const r = Object.keys(sectionsToReset[configKey]).map((sectionKey) => {
      return [configKey, sectionKey];
    });
    return [...acc, ...r];
  },
  []
);

export const builtInResetCommands = configSectionMapping.map(
  ([configKey, sectionKey]) => {
    return `while uci -q delete ${configKey}.@${sectionKey}[0]; do :; done`;
  }
);

export const builtInRevertCommands = Object.keys(sectionsToReset).map(
  (configKey) => {
    return `uci revert ${configKey}`;
  }
);

export const getDeviceScript = ({ state }: { state: OpenWrtState }) => {
  const uciCommands = getUciCommands({ openWrtConfig: state.config });

  return [
    ...(state.packagesToUninstall && state.packagesToUninstall.length > 0
      ? [
          `opkg remove --force-removal-of-dependent-packages ${state.packagesToUninstall.join(
            " "
          )}`,
        ]
      : []),
    ...(state.packagesToInstall && state.packagesToInstall.length > 0
      ? [
          `opkg update;`,
          `opkg install ${state.packagesToInstall
            .map((p) => p.packageName)
            .join(" ")}`,
        ]
      : []),
    ...builtInResetCommands,
    ...uciCommands,
    "uci commit",
    "reload_config",
  ];
};
