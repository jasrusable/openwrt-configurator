import { Config, Device } from ".";

type Mapping = {
  name: string;
  commands: ({
    config,
    deviceConfig,
  }: {
    config: Config;
    deviceConfig: Device;
  }) => string[];
};

export const configMapping: Mapping[] = [
  {
    name: "system",
    commands: ({ config, deviceConfig }) => {
      return [
        // Clear system settings.
        "while uci -q delete system.@system[0]; do :; done",
        // Set main system section.
        `uci set system.main=system`,
        // Hostname
        `uci set system.main.hostname='${deviceConfig.hostname}'`,
        // Timezone
        `uci set system.main.zonename='${config.general.timezone}'`,
        // Other
        `uci set system.main.ttylogin='0'`,
        `uci set system.main.log_size='64'`,
        `uci set system.main.conloglevel='8'`,
        `uci set system.main.cronloglevel='5'`,
        // NTP
        // Clear ntp settings.
        "while uci -q delete system.ntp; do :; done",
        // `uci set system.ntp=timeserver`,
        // `uci add_list system.ntp.server="0.openwrt.pool.ntp.org"`,
        // `uci add_list system.ntp.server="1.openwrt.pool.ntp.org"`,
        // `uci add_list system.ntp.server="2.openwrt.pool.ntp.org"`,
        // `uci add_list system.ntp.server="3.openwrt.pool.ntp.org"`,
      ];
    },
  },
  {
    name: "dropbear",
    commands: ({ config, deviceConfig }) => {
      return [
        // Clear dropbear settings.
        "while uci -q delete dropbear.@dropbear[0]; do :; done",
        `uci set dropbear.main=dropbear`,
        `uci set dropbear.main.PasswordAuth='on'`,
        `uci set dropbear.main.Port='22'`,
        `uci set dropbear.main.Interface='lan'`,
      ];
    },
  },
];

export const getDeviceScript = ({
  config,
  deviceConfig,
}: {
  config: Config;
  deviceConfig: Device;
}) => {
  const configCommands = configMapping.reduce((acc, curr) => {
    return [...acc, ...curr.commands({ config, deviceConfig })];
  }, [] as string[]);

  const commands = [...configCommands];

  return commands;
};
