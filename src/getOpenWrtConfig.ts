import { DeviceSchema } from "./deviceSchema";
import {
  configConfigSchema,
  ExtensionSchema,
  ONCConfig,
  ONCDeviceConfig,
  Targets,
} from "./oncConfigSchema";
import { OpenWrtConfig, openWrtConfigSchema } from "./openWrtConfigSchema";
import { omit } from "lodash";
import { getNetworkDevices, parseSchema } from "./utils";

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

  const targetMatches = (targets?: Targets) => {
    if (!targets) {
      return true;
    }

    if (typeof targets === "string") {
      return targets === "*";
    }

    const tagMatches =
      Array.isArray(targets) &&
      targets.find((target) =>
        deviceConfig.tags.find((tag) =>
          tag.name === target.tag &&
          typeof target.value === "string" &&
          target.value === "*"
            ? true
            : Array.isArray(target.value)
            ? !!target.value.find((val) => tag.value.includes(val))
            : false
        )
      );
    if (tagMatches) {
      return true;
    }

    const optMatches =
      Array.isArray(targets) &&
      targets.find(
        (target) => target.opt === "sw_config" && target.value === useSwConfig
      );

    if (optMatches) {
      return true;
    }

    return false;
  };

  const applyConfig = <S extends Record<string, any>>(section: S) => {
    const sectionConfig = section["."] as ExtensionSchema | undefined;
    const targets = sectionConfig?.targets;
    const matches = targetMatches(targets);
    const overrides = (sectionConfig?.target_overrides || [])
      .filter((override) => {
        return targetMatches(override.targets);
      })
      .reduce((acc, override) => {
        return { ...acc, ...override.overrides };
      }, {});
    return matches ? omit({ ...section, ...overrides }, ".") : {};
  };

  const resolvedOncConfig = Object.keys(oncConfig.config).reduce(
    (config, configKey) => {
      const a = applyConfig((oncConfig.config as any)[configKey]);
      const resolvedConfig = Object.keys(a).reduce((section, sectionKey) => {
        const sections: any[] = (a as any)[sectionKey] || [];
        const resolvedSections = sections
          .map((section) => {
            const resolvedSection = applyConfig(section);
            return resolvedSection;
          })
          .filter((section) => Object.keys(section).length > 0);
        return { ...section, [sectionKey]: resolvedSections };
      }, {});
      return { ...config, [configKey]: resolvedConfig };
    },
    {}
  ) as ONCConfig["config"];

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

  const allDevices = getNetworkDevices({
    oncConfigConfig: resolvedOncConfig,
    deviceSchema,
  });

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

  // console.log(JSON.stringify(resolvedOpenWrtConfig.network, null, 4));

  const openWrtConfig = parseSchema(openWrtConfigSchema, resolvedOpenWrtConfig);

  return openWrtConfig;
};
