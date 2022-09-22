import { DeviceSchema } from "./deviceSchema";
import { getLuciCommands } from "./getLuciCommands";
import { getOpenWRTConfig } from "./getOpenWRTConfig";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";

export const resetCommands = [
  // Clear network settings.
  "while uci -q delete network.@interface[0]; do :; done",
  "while uci -q delete network.@device[0]; do :; done",
  "while uci -q delete network.@switch_vlan[0]; do :; done",
  "while uci -q delete network.@switch[0]; do :; done",
  // Clear firewall settings.
  "while uci -q delete firewall.@defaults[0]; do :; done",
  "while uci -q delete firewall.@zone[0]; do :; done",
  "while uci -q delete firewall.@forwarding[0]; do :; done",
  "while uci -q delete firewall.@rule[0]; do :; done",
  // Clear wireless settings.
  "while uci -q delete wireless.@wifi-iface[0]; do :; done",
  "while uci -q delete wireless.@wifi-device[0]; do :; done",
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
  const openWRTConfig = getOpenWRTConfig({
    oncConfig: oncConfig,
    deviceConfig,
    deviceSchema,
  });
  const luciCommands = getLuciCommands({ openWRTConfig });

  return [...resetCommands, ...luciCommands];
};
