import { NodeSSH } from "node-ssh";
import { dhcpSectionsToReset } from "./configSchemas/dhcp";
import { firewallSectionsToReset } from "./configSchemas/firewall";
import { networkSectionsToReset } from "./configSchemas/network";
import { systemSectionsToReset } from "./configSchemas/system";
import { wirelessSectionsToReset } from "./configSchemas/wireless";
import { getUciCommands } from "./getUciCommands";
import { OpenWrtState } from "./openWrtConfigSchema";
import { getInstalledPackages } from "./utils";

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

export const getDeviceScript = async ({
  state,
  ssh,
}: {
  state: OpenWrtState;
  ssh?: NodeSSH;
}) => {
  const uciCommands = getUciCommands({ openWrtConfig: state.config });

  const configSections =
    state.configSectionsToReset &&
    Object.keys(state.configSectionsToReset).reduce<string[][]>(
      (acc, configKey) => {
        const sections = (state.configSectionsToReset?.[configKey] || []).map(
          (sectionKey) => [configKey, sectionKey]
        );
        return [...acc, ...sections];
      },
      []
    );

  const resetCommands = configSections
    ? configSections.map(([configKey, sectionKey]) => {
        return `while uci -q delete ${configKey}.@${sectionKey}[0]; do :; done`;
      })
    : [];

  const installedPackages = ssh ? await getInstalledPackages(ssh) : undefined;

  const packagesToUninstall = installedPackages
    ? (state.packagesToUninstall || []).filter((p) =>
        installedPackages.find((pk) => pk.packageName === p)
      )
    : state.packagesToUninstall;

  const packagesToInstall = installedPackages
    ? (state.packagesToInstall || []).filter(
        (p) => !installedPackages.find((pk) => pk.packageName === p.packageName)
      )
    : state.packagesToInstall;

  const opkgCommands = [
    ...(packagesToUninstall && packagesToUninstall.length > 0
      ? [
          `opkg remove --force-removal-of-dependent-packages ${packagesToUninstall.join(
            " "
          )}`,
        ]
      : []),
    ...(packagesToInstall && packagesToInstall.length > 0
      ? [
          `opkg update;`,
          `opkg install ${packagesToInstall
            .map((p) => p.packageName)
            .join(" ")}`,
        ]
      : []),
  ];

  return [
    ...opkgCommands,
    ...resetCommands,
    ...uciCommands,
    "uci commit",
    "reload_config",
  ];
};
