import { dhcpResetCommands } from "./configSchemas/dhcp";
import { firewallResetCommands } from "./configSchemas/firewall";
import { networkResetCommands } from "./configSchemas/network";
import { systemResetCommands } from "./configSchemas/system";
import { wirelessResetCommands } from "./configSchemas/wireless";
import { DeviceSchema } from "./deviceSchema";
import { getLuciCommands } from "./getLuciCommands";
import { getOpenWrtConfig } from "./getOpenWrtConfig";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";

export const resetCommands = [
  ...systemResetCommands,
  ...networkResetCommands,
  ...dhcpResetCommands,
  ...firewallResetCommands,
  ...wirelessResetCommands,
];

export const revertCommands = [
  `uci revert system`,
  `uci revert network`,
  `uci revert firewall`,
  `uci revert dhcp`,
  `uci revert dropbear`,
  `uci revert wireless`,
];

export const getDeviceScript = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const openWRTConfig = getOpenWrtConfig({
    oncConfig: oncConfig,
    deviceConfig,
    deviceSchema,
  });
  const luciCommands = getLuciCommands({ openWRTConfig });

  return [...resetCommands, ...luciCommands];
};
