import {
  DeviceConfig,
  deviceConfigSchema,
  deviceSchema,
  DeviceSchema,
} from "./configSchema";
import fs from "fs";

type Mapping = {
  name: string;
  commands: ({
    config,
    schema,
  }: {
    config: DeviceConfig;
    schema: DeviceSchema;
  }) => string[];
};

export const configMapping: Mapping[] = [
  {
    name: "system",
    commands: ({ config }) => {
      return [
        // Clear system settings.
        "while uci -q delete system.@system[0]; do :; done",

        // Set main system section.
        `uci set system.main=system`,

        // Hostname
        `uci set system.main.hostname='${config.system.hostname}'`,

        // Timezone
        `uci set system.main.zonename='${config.system.timezone}'`,

        // Other
        `uci set system.main.ttylogin='0'`,
        `uci set system.main.log_size='64'`,
        `uci set system.main.conloglevel='8'`,
        `uci set system.main.cronloglevel='5'`,

        // NTP
        // Clear ntp settings.
        "while uci -q delete system.ntp; do :; done",
      ];
    },
  },
  {
    name: "network",
    commands: ({ config, schema }) => {
      const dsaOrSwConfig = "swConfig";

      const cpuPort = (schema.ports || []).find((port) => port.role === "cpu");
      const cpuPortName = cpuPort?.name;
      const cpuPortCpuName = cpuPort?.cpuName;

      if (dsaOrSwConfig === "swConfig" && (!cpuPort || !cpuPortCpuName)) {
        throw new Error("CPU port not defined.");
      }

      return [
        // Clear network settings.
        "while uci -q delete network.@interface[0]; do :; done",
        "while uci -q delete network.@device[0]; do :; done",
        "while uci -q delete network.@switch_vlan[0]; do :; done",
        "while uci -q delete network.@switch[0]; do :; done",

        // Set loopback interface.
        `uci set network.loopback=interface`,
        `uci set network.loopback.device='lo'`,
        `uci set network.loopback.proto='static'`,
        `uci set network.loopback.ipaddr='127.0.0.1'`,
        `uci set network.loopback.netmask='255.0.0.0'`,

        // TODO: Is this needed?
        // Set ula prefix globals
        // `uci set network.globals=globals`,
        // `uci set network.globals.ula_prefix='fdf5:11bc:9159::/48'`,

        ...(dsaOrSwConfig === "swConfig"
          ? [
              // Create swConfig switch.
              `uci set network.switch=switch`,
              `uci set network.switch.name='switch0'`,
              `uci set network.switch.reset='1'`,
              `uci set network.switch.enable_vlan='1'`,
              ...config.devices.reduce<string[]>((acc, device, index) => {
                const portsList = [...device.ports, `${cpuPortName}t`]
                  .map((port) => {
                    const name = port.replace("eth", "");
                    return name;
                  })
                  .join(" ");

                const vlan = index + 1;

                // Create swConfig switch vlans
                const switchVlanCommands = [
                  `uci set network.switch_vlan${index}=switch_vlan`,
                  `uci set network.switch_vlan${index}.device='switch0'`,
                  `uci set network.switch_vlan${index}.vlan='${vlan}'`,
                  `uci set network.switch_vlan${index}.ports='${portsList}'`,
                ];

                // Create devices
                const deviceCommands = [
                  `uci set network.device${index}=device`,
                  `uci set network.device${index}.name='${device.name}'`,
                  `uci set network.device${index}.type='${device.type}'`,
                  ...(device.type === "bridge"
                    ? [
                        `uci set network.device${index}.ports='${cpuPortCpuName}.${vlan}'`,
                      ]
                    : []),
                ];

                return [...acc, ...switchVlanCommands, ...deviceCommands];
              }, []),
            ]
          : []),

        // Create interfaces
        ...config.interfaces.reduce<string[]>((acc, interface_) => {
          return [
            ...acc,
            ...[
              // General settings
              `uci set network.${interface_.name}=interface`,
              `uci set network.${interface_.name}.device='${interface_.device}'`,
              `uci set network.${interface_.name}.force_link='${
                interface_.forceLink === false ? 0 : 1
              }'`,
              `uci set network.${interface_.name}.defaultroute='${
                interface_.useDefaultGateway === false ? 0 : 1
              }'`,
              `uci set network.${interface_.name}.auto='${
                interface_.bringUpAtBoot === false ? 0 : 1
              }'`,
              `uci set network.${interface_.name}.proto='${interface_.proto}'`,

              // Static settings
              ...(interface_.proto === "static"
                ? [
                    // ipv4
                    `uci set network.${interface_.name}.ipaddr='${interface_.ipv4Address}'`,
                    `uci set network.${interface_.name}.netmask='${interface_.ipv4NetMask}'`,
                    `uci set network.${interface_.name}.gateway='${interface_.ipv4Gateway}'`,
                    `uci set network.${interface_.name}.broadcast='${interface_.ipv4Broadcast}'`,
                    // ipv6
                    ...(interface_.ipv6Addresses || []).map((address) => {
                      return `uci add_list network.${interface_.name}.ip6addr='${address}'`;
                    }),
                    `uci set network.${interface_.name}.ip6gw='${interface_.ipv6Gateway}'`,
                    `uci set network.${interface_.name}.ip6prefix='${interface_.ipv6Prefix}'`,
                  ]
                : []),
            ],
          ];
        }, []),
      ];
    },
  },
  {
    name: "wireless",
    commands: ({ config, schema }) => {
      const defaultBandChannels = {
        "2g": 1,
        "5g": 36,
      };

      return [
        // Clear wireless settings.
        "while uci -q delete wireless.@wifi-iface[0]; do :; done",
        "while uci -q delete wireless.@wifi-device[0]; do :; done",

        // Set up radios
        ...(schema.radios || []).reduce<string[]>((acc, radio) => {
          const configRadio = config.wireless.radios.find(
            (r) => r.name === radio.name
          );

          const channel =
            configRadio?.channel || defaultBandChannels[radio.band];

          return [
            ...acc,
            `uci set wireless.${radio.name}=wifi-device`,
            `uci set wireless.${radio.name}.type='${radio.type}'`,
            `uci set wireless.${radio.name}.path='${radio.path}'`,
            `uci set wireless.${radio.name}.channel='${channel}'`,
            `uci set wireless.${radio.name}.band='${radio.band}'`,
            `uci set wireless.${radio.name}.htmode='${radio.htmode}'`,
            `uci set wireless.${radio.name}.disabled='${
              configRadio?.disabled === true ? 1 : 0
            }'`,
          ];
        }, []),

        // Set up networks
        ...config.wireless.networks.reduce<string[]>(
          (acc, wirelessNetwork, index) => {
            const name = `wifinet${index}`;
            return [
              ...acc,
              `uci set wireless.${name}=wifi-iface`,
              `uci set wireless.${name}.device='${wirelessNetwork.device}'`,
              `uci set wireless.${name}.mode='${wirelessNetwork.mode}'`,
              `uci set wireless.${name}.network='${wirelessNetwork.network}'`,

              // AP settings
              ...(wirelessNetwork.mode === "ap"
                ? [
                    `uci set wireless.${name}.ssid='${wirelessNetwork.ssid}'`,
                    `uci set wireless.${name}.encryption='${wirelessNetwork.encryption}'`,
                    `uci set wireless.${name}.key='${wirelessNetwork.key}'`,
                    `uci set wireless.${name}.wmm='${
                      wirelessNetwork.wmm === false ? 0 : 1
                    }'`,
                  ]
                : []),
            ];
          },
          []
        ),
      ];
    },
  },
  {
    name: "ssh",
    commands: ({ config }) => {
      return [
        // Clear dropbear settings.
        "while uci -q delete dropbear.@dropbear[0]; do :; done",

        // Enable ssh on lan interface
        `uci set dropbear.main=dropbear`,
        `uci set dropbear.main.PasswordAuth='on'`,
        `uci set dropbear.main.Port='22'`,
        `uci set dropbear.main.Interface='lan'`,
      ];
    },
  },
  {
    name: "reloads",
    commands: () => {
      return ["uci commit", "service system reload", "service network reload"];
    },
  },
];

export const getDeviceCommands = ({
  config,
  schema,
}: {
  config: DeviceConfig;
  schema: DeviceSchema;
}) => {
  const configCommands = configMapping.reduce((acc, curr) => {
    return [...acc, ...curr.commands({ config, schema })];
  }, [] as string[]);

  const commands = [...configCommands];

  return commands;
};

const config = deviceConfigSchema.parse(
  JSON.parse(fs.readFileSync("./src/deviceConfig/deviceConfig.json", "utf-8"))
);

const schema = deviceSchema.parse(
  JSON.parse(
    fs.readFileSync(`./deviceSchemas/${config.target.deviceId}.json`, "utf-8")
  )
);

const commands = getDeviceCommands({ config, schema });

console.log(commands.join("\n"));
