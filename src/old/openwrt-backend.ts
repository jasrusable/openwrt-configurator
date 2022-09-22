import { Config, DeviceConfig, Roles, WifiEncryption } from ".";
import { DeviceSchema } from "./deviceConfig/configSchema";
import semver from "semver";

type Mapping = {
  name: string;
  commands: ({
    config,
    deviceConfig,
    deviceSchema,
  }: {
    config: Config;
    deviceConfig: DeviceConfig;
    deviceSchema: DeviceSchema;
  }) => string[];
};

export const getDeviceScript = ({
  config,
  deviceConfig,
  deviceSchema,
}: {
  config: Config;
  deviceConfig: DeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const isRouter = deviceConfig.roles.includes(Roles.Router);

  const swConfigVersionRange = deviceSchema.flags.swConfig
    .split(".")
    .map((n, index) => (index === 1 ? parseInt(n) : n))
    .join(".");

  const deviceVersion = deviceConfig.version
    .split(".")
    .map((n) => parseInt(n, 10))
    .join(".");

  const dsaOrSwConfig = semver.satisfies(deviceVersion, swConfigVersionRange)
    ? "swConfig"
    : "dsa";

  const cpuPort = (deviceSchema.ports || []).find(
    (port) => port.role === "cpu"
  );

  const configMapping: Mapping[] = [
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
        ];
      },
    },
    {
      name: "network",
      commands: ({ config, deviceConfig, deviceSchema }) => {
        const ports = deviceSchema.ports || [];
        const lanPorts = ports.filter((port) => port.role === "lan");

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
                ...config.networks
                  .filter((network) => !!network.devices)
                  .reduce<string[]>((acc, network, index) => {
                    if (!cpuPort || !cpuPort.cpuName) {
                      throw new Error("CPU port not defined.");
                    }

                    const portNamesList = ports
                      .map((port) => {
                        const name = port.name.replace("eth", "");
                        return port.role === "cpu"
                          ? `${name}t`
                          : network.vlanUntagged === true
                          ? name
                          : `${name}t`;
                      })
                      .join(" ");

                    const switchVlanCommands = [
                      `uci set network.switch_vlan${index}=switch_vlan`,
                      `uci set network.switch_vlan${index}.device='switch0'`,
                      `uci set network.switch_vlan${index}.vlan='${network.vlan}'`,
                      `uci set network.switch_vlan${index}.ports='${portNamesList}'`,
                    ];

                    const deviceCommands = [
                      `uci set network.device${index}=device`,
                      `uci set network.device${index}.name='br-lan.${network.vlan}'`,
                      `uci set network.device${index}.type='bridge'`,
                      `uci set network.device${index}.ports='${cpuPort.cpuName}.${network.vlan}'`,
                    ];

                    return [...acc, ...switchVlanCommands, ...deviceCommands];
                  }, []),
              ]
            : [
                `uci set network.device${0}=device`,
                `uci set network.device${0}.name='br-lan'`,
                `uci set network.device${0}.type='bridge'`,
                `uci set network.device${0}.ports=${lanPorts
                  .map((port) => `'${port.name}'`)
                  .join(" ")}`,
                ...config.networks.reduce<string[]>((acc, network, index) => {
                  const portNames = lanPorts
                    .map(
                      (port) =>
                        `'${port.name}${network.vlanUntagged ? "" : ":t"}'`
                    )
                    .join(" ");

                  const vlanBridgeCommands = [
                    `uci set network.bridge-vlan${index}=bridge-vlan`,
                    `uci set network.bridge-vlan${index}.device='br-lan'`,
                    `uci set network.bridge-vlan${index}.vlan='${network.vlan}'`,
                    `uci set network.bridge-vlan${index}.ports='${portNames}'`,
                  ];
                  return [...acc, ...vlanBridgeCommands];
                }, []),
              ]),

          // Create interfaces
          ...config.networks.reduce<string[]>((acc, network) => {
            const networkConfig = isRouter ? network.router : network.devices;

            return networkConfig
              ? [
                  ...acc,
                  ...[
                    // General settings
                    `uci set network.${network.name}=interface`,
                    `uci set network.${network.name}.device='${
                      network.router?.device || `br-lan.${network.vlan}`
                    }'`,
                    `uci set network.${network.name}.proto='${networkConfig.protocol}'`,
                    // Static settings
                    ...(networkConfig.protocol === "static"
                      ? [
                          // ipv4
                          `uci set network.${network.name}.ipaddr='${networkConfig.ip}'`,
                          `uci set network.${network.name}.netmask='${networkConfig.netmask}'`,
                        ]
                      : []),
                  ],
                ]
              : [];
          }, []),
        ];
      },
    },
    {
      name: "wireless",
      commands: ({ config }) => {
        const defaultBandChannels = {
          "2g": 1,
          "5g": 36,
        };

        return [
          // Clear wireless settings.
          "while uci -q delete wireless.@wifi-iface[0]; do :; done",
          "while uci -q delete wireless.@wifi-device[0]; do :; done",

          // Set up radios
          ...(deviceSchema.radios || []).reduce<string[]>((acc, radio) => {
            const channel = defaultBandChannels[radio.band];

            return [
              ...acc,
              `uci set wireless.${radio.name}=wifi-device`,
              `uci set wireless.${radio.name}.type='${radio.type}'`,
              `uci set wireless.${radio.name}.path='${radio.path}'`,
              `uci set wireless.${radio.name}.channel='${channel}'`,
              `uci set wireless.${radio.name}.band='${radio.band}'`,
              `uci set wireless.${radio.name}.htmode='${radio.htmode}'`,
            ];
          }, []),

          // Set up networks
          ...config.wifi.reduce<string[]>((acc, wifi, index) => {
            const radios = deviceSchema.radios || [];

            return [
              ...acc,
              ...radios.reduce<string[]>((acc, radio, radioIndex) => {
                const name = `wifinet${index}${radioIndex}`;

                return [
                  ...acc,
                  `uci set wireless.${name}=wifi-iface`,
                  `uci set wireless.${name}.device='${radio.name}'`,
                  `uci set wireless.${name}.mode='ap'`,
                  `uci set wireless.${name}.network='${wifi.network}'`,

                  // AP settings
                  ...(wifi.mode === "ap"
                    ? [
                        `uci set wireless.${name}.ssid='${wifi.ssid}'`,
                        `uci set wireless.${name}.encryption='${wifi.encryption}'`,
                        ...(wifi.encryption !== WifiEncryption.None
                          ? [`uci set wireless.${name}.key='${wifi.key}'`]
                          : []),
                      ]
                    : []),
                ];
              }, []),
            ];
          }, []),
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
    {
      name: "firewall",
      commands: ({ config, deviceConfig, deviceSchema }) => {
        const isRouter = deviceConfig.roles.includes(Roles.Router);

        const forwardings = config.firewall.zones.reduce<
          { source: string; destination: string }[]
        >((acc, zone) => {
          const forwards = (zone.forwardings || []).map((toNetwork) => ({
            source: zone.name,
            destination: toNetwork,
          }));
          return [...acc, ...forwards];
        }, []);

        return [
          // Clear firewall settings.
          "while uci -q delete firewall.@defaults[0]; do :; done",
          "while uci -q delete firewall.@zone[0]; do :; done",
          "while uci -q delete firewall.@forwarding[0]; do :; done",
          "while uci -q delete firewall.@rule[0]; do :; done",
          ...(isRouter
            ? [
                `uci set firewall.defaults=defaults`,
                `uci set firewall.defaults.input='${config.firewall.defaults.input.toUpperCase()}'`,
                `uci set firewall.defaults.output='${config.firewall.defaults.output.toUpperCase()}'`,
                `uci set firewall.defaults.forward='${config.firewall.defaults.forward.toUpperCase()}'`,
                `uci set firewall.defaults.synflood_protect='${
                  config.firewall.defaults.synFloodProtect ? 1 : 0
                }'`,

                // Firewall zones
                ...config.firewall.zones.reduce<string[]>(
                  (acc, zone, zoneIndex) => {
                    const networkNames = config.networks
                      .filter(
                        (network) => network.router?.firewallZone === zone.name
                      )
                      .map((network) => network.name);

                    return [
                      ...acc,
                      `uci set firewall.zone${zoneIndex}=zone`,
                      `uci set firewall.zone${zoneIndex}.name='${zone.name}'`,
                      `uci set firewall.zone${zoneIndex}.input='${zone.input.toUpperCase()}'`,
                      `uci set firewall.zone${zoneIndex}.output='${zone.output.toUpperCase()}'`,
                      `uci set firewall.zone${zoneIndex}.forward='${zone.forward.toUpperCase()}'`,
                      `uci set firewall.zone${zoneIndex}.network=${networkNames
                        .map((name) => `'${name}'`)
                        .join(" ")}`,
                    ];
                  },
                  []
                ),

                // Firewall rules
                ...config.firewall.rules.reduce<string[]>(
                  (acc, rule, ruleIndex) => {
                    return [
                      ...acc,
                      `uci set firewall.rule${ruleIndex}=rule`,
                      `uci set firewall.rule${ruleIndex}.name='${rule.name}'`,
                      ...(rule.sourceZone
                        ? [
                            `uci set firewall.rule${ruleIndex}.src='${rule.sourceZone}'`,
                          ]
                        : []),
                      ...(rule.sourceIps
                        ? [
                            `uci set firewall.rule${ruleIndex}.src_ip=${
                              Array.isArray(rule.sourceIps)
                                ? rule.sourceIps
                                    .map((ip) => `'${ip}'`)
                                    .join(" ")
                                : rule.sourceIps
                            }`,
                          ]
                        : []),
                      ...(rule.protocols
                        ? [
                            `uci set firewall.rule${ruleIndex}.proto=${rule.protocols
                              .map((proto) => `'${proto}'`)
                              .join(" ")}`,
                          ]
                        : []),
                      ...(rule.icmpType
                        ? [
                            `uci set firewall.rule${ruleIndex}.icmp_type=${rule.icmpType
                              .map((type) => `'${type}'`)
                              .join(" ")}`,
                          ]
                        : []),
                      ...(rule.destinationZone
                        ? [
                            `uci set firewall.rule${ruleIndex}.dest='${rule.destinationZone}'`,
                          ]
                        : []),
                      ...(rule.destinationIps
                        ? [
                            `uci set firewall.rule${ruleIndex}.dest_ip=${
                              Array.isArray(rule.destinationIps)
                                ? rule.destinationIps
                                    .map((ip) => `'${ip}'`)
                                    .join(" ")
                                : rule.destinationIps
                            }`,
                          ]
                        : []),
                      ...(rule.destinationPorts
                        ? [
                            `uci set firewall.rule${ruleIndex}.dest_port='${
                              Array.isArray(rule.destinationPorts)
                                ? rule.destinationPorts.join(" ")
                                : rule.destinationPorts
                            }'`,
                          ]
                        : []),
                      ...(rule.family
                        ? [
                            `uci set firewall.rule${ruleIndex}.family=${
                              Array.isArray(rule.family)
                                ? rule.family
                                    .map((family) => `'${family}'`)
                                    .join(" ")
                                : rule.family
                            }`,
                          ]
                        : []),
                      `uci set firewall.rule${ruleIndex}.target='${rule.target.toUpperCase()}'`,
                      ...(rule.limit
                        ? [
                            `uci set firewall.rule${ruleIndex}.limit='${rule.limit}'`,
                          ]
                        : []),
                    ];
                  },
                  []
                ),
              ]
            : []),
        ];
      },
    },
    {
      name: "reloads",
      commands: () => {
        return [
          "uci commit",
          "service system reload",
          "service network reload",
        ];
      },
    },
  ];

  const configCommands = configMapping.reduce((acc, curr) => {
    return [...acc, ...curr.commands({ config, deviceConfig, deviceSchema })];
  }, [] as string[]);

  const commands = [...configCommands];

  return commands;
};
