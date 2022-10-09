import { dhcpSectionsToReset } from "./configSchemas/dhcp";
import { firewallSectionsToReset } from "./configSchemas/firewall";
import { networkSectionsToReset } from "./configSchemas/network";
import { systemSectionsToReset } from "./configSchemas/system";
import { wirelessSectionsToReset } from "./configSchemas/wireless";
import { getUciCommands } from "./getUciCommands";
import { OpenWrtConfig } from "./openWrtConfigSchema";

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

export const getDeviceScript = ({
  openWrtConfig,
}: {
  openWrtConfig: OpenWrtConfig;
}) => {
  const uciCommands = getUciCommands({ openWrtConfig });

  return [
    ...builtInResetCommands,
    ...uciCommands,
    "uci commit",
    "reload_config",
  ];
};
