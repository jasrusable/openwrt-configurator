import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { OpenWrtConfig, openWrtConfigSchema } from "./openWrtConfigSchema";
import { getNetworkDevices, parseSchema } from "./utils";
import { resolveOncConfig } from "./resolveOncConfig";

export const getOpenWrtConfig = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const useSwConfig = deviceSchema.swConfig;
  const ports = deviceSchema.ports || [];
  const cpuPort = ports.find((port) => !!port.swConfigCpuName);
  const expectCpuPort = () => {
    if (!cpuPort?.swConfigCpuName) {
      throw new Error(`CPU port not defined`);
    }

    return cpuPort as { name: string; swConfigCpuName: string };
  };
  const physicalPorts = ports.filter((port) => !port.swConfigCpuName);
  const radios = deviceSchema.radios || [];

  const resolvedOncConfig = resolveOncConfig({
    deviceConfig,
    deviceSchema,
    oncConfig,
  });

  const bridgedDevices = (resolvedOncConfig.network.device || [])
    .filter((device) => device.type === "bridge")
    .reduce<string[]>((acc, device) => {
      const devices = (Array.isArray(device.ports) ? device.ports : []).map(
        (device) =>
          device.startsWith("@cpu_port")
            ? device.replace("@cpu_port", expectCpuPort().swConfigCpuName)
            : device
      );
      return [...new Set([...acc, ...devices])];
    }, []);

  const interfacedDevices = (resolvedOncConfig.network.interface || [])
    .map((interface_) => {
      return interface_.device;
    })
    .filter((device) => !!device);

  const usedDeviceNames = [...bridgedDevices, ...interfacedDevices];

  const unusedPhysicalPorts = physicalPorts.filter(
    (port) => !usedDeviceNames.includes(port.name)
  );

  const swConfigUntaggedPortNames = [
    ...(resolvedOncConfig.network.switch_vlan || []).reduce<string[]>(
      (acc, switchVlan) => {
        const untaggedPorts = Array.isArray(switchVlan.ports)
          ? switchVlan.ports.filter((port) => {
              const [portName, flags] = port.split(":");
              const isUntagged = !flags || (flags && !flags.includes("t"));
              return isUntagged;
            })
          : [];
        return [...acc, ...untaggedPorts];
      },
      []
    ),
  ];

  const swConfigPortsWhichCanBeUntagged = physicalPorts.filter(
    (port) => !swConfigUntaggedPortNames.includes(port.name)
  );

  const getDevicePorts = (deviceName: string) => {
    const deviceSection = (resolvedOncConfig.network.device || []).find(
      (device) => device.name === deviceName
    );
    if (!deviceSection || !deviceSection.ports) {
      return [];
    }

    return (
      typeof deviceSection.ports === "string"
        ? (deviceSection.ports === "*"
            ? physicalPorts
            : deviceSection.ports === "&*"
            ? unusedPhysicalPorts
            : []
          ).map((port) => port.name)
        : deviceSection.ports
    ).map((portName: string) => {
      const vlan = portName.split(".")[1];
      return portName.startsWith("@cpu_port")
        ? `${expectCpuPort().swConfigCpuName}${vlan ? `.${vlan}` : ""}`
        : portName;
    });
  };

  const resolvedOpenWrtConfig = Object.keys(resolvedOncConfig).reduce(
    (config, configKey) => {
      const resolvedConfig = Object.keys(
        (resolvedOncConfig as any)[configKey]
      ).reduce((section, sectionKey) => {
        const sections: any[] =
          (resolvedOncConfig as any)[configKey][sectionKey] || [];
        const resolvedSections = sections.map((resolvedSection: any) => {
          return {
            ...(resolvedSection.name ? { name: resolvedSection.name } : {}),
            properties: {
              ...resolvedSection,

              // Add hostname
              ...(configKey === "system" &&
                sectionKey === "system" && {
                  hostname: deviceConfig.hostname,
                }),

              // Resolve device ports
              ...(configKey === "network" &&
                sectionKey === "device" && {
                  ports: getDevicePorts(resolvedSection.name),
                }),

              // Resolve bridge-vlan ports
              ...(configKey === "network" &&
                sectionKey === "bridge-vlan" && {
                  ports: getDevicePorts(resolvedSection.device).map((port) => {
                    if (typeof resolvedSection.ports === "string") {
                      return resolvedSection.ports === "*"
                        ? port
                        : resolvedSection.ports === "*t"
                        ? `${port}:t`
                        : "";
                    } else {
                      return resolvedSection.ports;
                    }
                  }),
                }),

              // Resolve switch_vlan ports
              ...(configKey === "network" &&
                sectionKey === "switch_vlan" && {
                  ports: [
                    ...[expectCpuPort()].map((port) => {
                      return `${port.name}:t`;
                    }),
                    ...(typeof resolvedSection.ports === "string"
                      ? (resolvedSection.ports.startsWith("*")
                          ? physicalPorts
                          : resolvedSection.ports.startsWith("&*")
                          ? swConfigPortsWhichCanBeUntagged
                          : []
                        ).map(
                          (port) =>
                            `${port.name}${
                              resolvedSection.ports.includes("t") ? ":t" : ""
                            }`
                        )
                      : resolvedSection.ports),
                  ]
                    .map((portName) =>
                      portName.replace("eth", "").replace(":", "")
                    )
                    .join(" "),
                }),

              // Resolve wifi-iface device
              ...(configKey === "wireless" &&
                sectionKey === "wifi-iface" && {
                  device: "radio0",
                }),
            },
          };
        });
        return { ...section, [sectionKey]: resolvedSections };
      }, {});
      return { ...config, [configKey]: resolvedConfig };
    },
    {}
  ) as OpenWrtConfig;

  const openWrtConfig = parseSchema(openWrtConfigSchema, resolvedOpenWrtConfig);

  return openWrtConfig;
};
