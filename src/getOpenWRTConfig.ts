import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import semver from "semver";
import { OpenWRTConfig } from "./openWRTConfigSchema";

export const getOpenWRTConfig = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const isRouter = deviceConfig.roles.includes("router");

  const swConfigVersionRange = deviceSchema.flags.swConfig
    .split(".")
    .map((n, index) => (index === 1 ? parseInt(n) : n))
    .join(".");

  const deviceVersion = deviceConfig.version
    .split(".")
    .map((n) => parseInt(n, 10))
    .join(".");

  const useSwConfig = !!semver.satisfies(deviceVersion, swConfigVersionRange);

  const cpuPort = (deviceSchema.ports || []).find(
    (port) => !!port.swConfigCpuName
  );

  const networks = oncConfig.network.networks.filter(
    (network) => !!network.vlan
  );

  const radios = deviceSchema.radios || [];

  const openWRTConfig: OpenWRTConfig = {
    system: {
      system: [
        {
          properties: {
            hostname: deviceConfig.system.hostname,
            timezone: oncConfig.system.timezone,
          },
        },
      ],
    },
    network: {
      ...(useSwConfig && {
        switch: [
          {
            properties: {
              name: "switch0",
              reset: true,
              enable_vlan: true,
            },
          },
        ],
        switch_vlan: networks.map((network) => {
          return {
            properties: {
              device: "switch0",
              vlan: network.vlan as number,
              ports: (deviceSchema.ports || [])
                .map((port) => {
                  const name = port.name.replace("eth", "");
                  return !!port.swConfigCpuName
                    ? `${name}t`
                    : network.vlan_untagged === true
                    ? name
                    : `${name}t`;
                })
                .join(" "),
            },
          };
        }),
      }),
      device: useSwConfig
        ? networks.map((network) => {
            if (!cpuPort || !cpuPort.swConfigCpuName) {
              throw new Error("CPU port not defined.");
            }
            return {
              properties: {
                name: `br-lan.${network.vlan}`,
                type: "bridge",
                ports: [`${cpuPort.swConfigCpuName}.${network.vlan}`],
              },
            };
          })
        : [
            {
              properties: {
                name: "br-lan",
                type: "bridge",
                ports: (deviceSchema.ports || []).map((port) => port.name),
              },
            },
          ],
      interface: [
        {
          name: "loopback",
          properties: {
            device: "lo",
            proto: "static",
            ipaddr: "127.0.0.1",
            netmask: "255.0.0.0",
          },
        },
        ...networks.map((network) => {
          return {
            name: network.name,
            properties: {
              device: `br-lan.${network.vlan}`,
              proto: "dhcp" as const,
            },
          };
        }),
      ],
    },
    ...(isRouter && {
      firewall: {
        defaults: [{ properties: oncConfig.firewall.defaults }],
        zone: oncConfig.firewall.zones.map((zone) => {
          return {
            properties: zone,
          };
        }),
        forwarding: oncConfig.firewall.forwardings.map((forwarding) => {
          return {
            properties: forwarding,
          };
        }),
        rule: oncConfig.firewall.rules.map((rule) => {
          return { properties: rule };
        }),
      },
    }),
    ...(radios.length > 0 && {
      wireless: {
        "wifi-device": radios.map((radio) => {
          const defaultBandChannels = {
            "2g": 1,
            "5g": 36,
          };
          return {
            name: radio.name,
            properties: {
              type: radio.type,
              path: radio.path,
              band: radio.band,
              channel: defaultBandChannels[radio.band],
              htmode: radio.htmodes[0],
            },
          };
        }),
        "wifi-iface": radios.reduce<any[]>((acc, radio, radioIndex) => {
          const wifiNetworks = oncConfig.wireless["wifi-iface"].map(
            (wifi, wifiIndex) => {
              const name = `wifinet${radioIndex}${wifiIndex}`;
              return {
                name,
                properties: {
                  device: radio.name,
                  mode: "ap",
                  network: wifi.network,
                  ssid: wifi.ssid,
                  encryption: wifi.encryption,
                  key: wifi.key,
                },
              };
            }
          );
          return [...acc, ...wifiNetworks];
        }, []),
      },
    }),
  };

  return openWRTConfig;
};
