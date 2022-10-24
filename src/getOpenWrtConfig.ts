import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { OpenWrtConfig, openWrtConfigSchema } from "./openWrtConfigSchema";
import { parseSchema } from "./utils";
import { resolveOncConfig, conditionMatches } from "./resolveOncConfig";

export const getOpenWrtConfig = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const useSwConfig = deviceSchema.sw_config;
  const ports = deviceSchema.ports || [];
  const cpuPort = ports.find((port) => !!port.sw_config_cpu_name);
  const expectCpuPort = () => {
    if (!cpuPort?.sw_config_cpu_name) {
      throw new Error(`CPU port not defined`);
    }
    return cpuPort as Required<NonNullable<DeviceSchema["ports"]>[number]>;
  };
  const physicalPorts = ports.filter((port) => !port.sw_config_cpu_name);

  const resolvedOncConfig = resolveOncConfig({
    deviceConfig,
    deviceSchema,
    oncConfig,
  });

  const bridgedDevices = (resolvedOncConfig.network?.device || [])
    .filter((device) => device.type === "bridge")
    .reduce<string[]>((acc, device) => {
      const devices = (Array.isArray(device.ports) ? device.ports : []).map(
        (device) =>
          device.startsWith("@cpu_port")
            ? device.replace("@cpu_port", expectCpuPort().sw_config_cpu_name)
            : device
      );
      return [...new Set([...acc, ...devices])];
    }, []);

  const interfacedDevices = (resolvedOncConfig.network?.interface || [])
    .map((interface_) => {
      return interface_.device;
    })
    .filter((device) => !!device);

  const usedDeviceNames = [...bridgedDevices, ...interfacedDevices];

  const unusedPhysicalPorts = physicalPorts.filter(
    (port) => !usedDeviceNames.includes(port.name)
  );

  const swConfigUntaggedPortNames = [
    ...(resolvedOncConfig.network?.switch_vlan || []).reduce<string[]>(
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
    const deviceSection = (resolvedOncConfig.network?.device || []).find(
      (device) => device.name === deviceName
    );
    if (!deviceSection || !deviceSection.ports) {
      return [];
    }

    return (
      typeof deviceSection.ports === "string"
        ? (deviceSection.ports === "*" ? unusedPhysicalPorts : []).map(
            (port) => port.name
          )
        : deviceSection.ports
    ).map((portName: string) => {
      const vlan = portName.split(".")[1];
      return portName.startsWith("@cpu_port")
        ? `${expectCpuPort().sw_config_cpu_name}${vlan ? `.${vlan}` : ""}`
        : portName;
    });
  };

  const sanitizeName = (name: string) => {
    return name.replace(/[^0-9a-z]/gi, "");
  };

  const resolvedOpenWrtConfig = Object.keys(resolvedOncConfig)
    .filter((key) => key !== "wireless")
    .reduce((config, configKey) => {
      const resolvedConfig = Object.keys(
        (resolvedOncConfig as any)[configKey]
      ).reduce((section, sectionKey) => {
        const sections: any[] =
          (resolvedOncConfig as any)[configKey][sectionKey] || [];
        const resolvedSections = sections.map(
          (oncSection: any, sectionIndex) => {
            const defaultName = sanitizeName(`${sectionKey}${sectionIndex}`);
            const name = oncSection[".name"] || defaultName;
            const resolvedSection: any = Object.fromEntries(
              Object.entries({ ...oncSection }).filter(
                (e) => ![".name"].includes(e[0])
              )
            );
            return {
              ".name": name,
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
              ...(!useSwConfig &&
                configKey === "network" &&
                sectionKey === "bridge-vlan" && {
                  ports: getDevicePorts(resolvedSection.device).map((port) => {
                    if (typeof resolvedSection.ports === "string") {
                      return resolvedSection.ports === "*"
                        ? port
                        : resolvedSection.ports === "*t"
                        ? `${port}:t`
                        : "";
                    } else {
                      // TODO: Test this case.
                      return resolvedSection.ports;
                    }
                  }),
                }),

              // Resolve switch_vlan ports
              ...(useSwConfig &&
                configKey === "network" &&
                sectionKey === "switch_vlan" && {
                  ports: [
                    `${expectCpuPort().name}:t`,
                    ...(typeof resolvedSection.ports === "string"
                      ? (resolvedSection.ports.startsWith("*")
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
            };
          }
        );
        return { ...section, [sectionKey]: resolvedSections };
      }, {});
      return { ...config, [configKey]: resolvedConfig };
    }, {}) as OpenWrtConfig;

  const defaultChannels = {
    "2g": 11,
    "5g": 36,
    "6g": 36,
    "60g": 36,
  };

  const radios = deviceSchema.radios || [];

  const radiosAndDevices = radios.map((radio) => {
    const wifiDevice = (resolvedOncConfig.wireless?.["wifi-device"] || []).find(
      (wifiDevice) => {
        return wifiDevice.band === radio.band;
      }
    );

    return {
      radio,
      wifiDevice,
    };
  });

  const wifiDevices: NonNullable<
    NonNullable<OpenWrtConfig["wireless"]>["wifi-device"]
  > = radiosAndDevices.reduce<any[]>((acc, { radio, wifiDevice }, index) => {
    const name = wifiDevice?.[".name"] || sanitizeName(`wifidevice${index}`);

    return [
      ...acc,
      {
        ...wifiDevice,
        ".name": name,
        channel: wifiDevice?.channel || defaultChannels[radio.band],
        type: radio.type,
        band: radio.band,
        path: radio.path,
      },
    ];
  }, []);

  type WifiInterface = NonNullable<
    NonNullable<OpenWrtConfig["wireless"]>["wifi-iface"]
  >;

  const wifiInterfaces: WifiInterface = (
    resolvedOncConfig.wireless?.["wifi-iface"] || []
  ).reduce<any[]>((acc, { device, ...wifiIface }, wifiIfaceIndex) => {
    const radioDeviceNames = wifiDevices.map((device) => device[".name"]);

    const devices =
      (typeof device === "string"
        ? device === "*"
          ? radioDeviceNames
          : [device]
        : device) || radioDeviceNames;

    const interfaces = devices.map((deviceName, deviceIndex) => {
      return {
        ".name": `wifinet${wifiIfaceIndex}${deviceIndex}`,
        device: deviceName,
        ...wifiIface,
      };
    });

    return [...acc, ...interfaces];
  }, []);

  const final: OpenWrtConfig = {
    ...resolvedOpenWrtConfig,
    ...(radios.length > 0 && {
      wireless: {
        "wifi-device": wifiDevices,
        "wifi-iface": wifiInterfaces,
      },
    }),
  };

  const openWrtConfig = parseSchema(openWrtConfigSchema, final);

  return openWrtConfig;
};
