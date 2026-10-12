import { resolveHtmode } from "./radioModes";
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

  // "@wan_port", as any whole value: the port board.json gives the WAN role,
  // so a config can name it without knowing the model (eth1 on one, wan on
  // another). "@wan_port.10" is that port's VLAN 10 (eth1.10).
  const wanPort = () => {
    const wan = physicalPorts.find((port) => port.default_role === "wan");
    if (!wan || useSwConfig) {
      throw new Error(
        `${deviceConfig.hostname} has no WAN port for "@wan_port"` +
          (useSwConfig ? " (not supported on swconfig devices yet)." : ".")
      );
    }
    return wan.name;
  };
  const withWanPort = (value: unknown): unknown =>
    typeof value === "string" && /^@wan_port(\.\d+)?$/.test(value)
      ? wanPort() + value.slice("@wan_port".length)
      : Array.isArray(value)
      ? value.map(withWanPort)
      : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([key, v]) => [key, withWanPort(v)])
        )
      : value;

  const resolvedOncConfig = withWanPort(
    resolveOncConfig({ deviceConfig, deviceSchema, oncConfig })
  ) as ReturnType<typeof resolveOncConfig>;

  // "*" means every physical port nothing else uses, and only explicit port
  // lists count as uses — so two "*" devices would each claim every free port,
  // and netifd would put each port in whichever it set up last. Resolved per
  // device, so "*" bridges whose .if never both apply are fine.
  const wildcardDevices = (resolvedOncConfig.network?.device || [])
    .filter((device) => device.ports === "*")
    .map((device) => device.name);
  if (wildcardDevices.length > 1) {
    const names = wildcardDevices.map((name) => `"${name}"`);
    throw new Error(
      `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} ${
        names.length === 2 ? "both" : "all"
      } use ` +
        `"ports": "*" on ${deviceConfig.hostname}, but a port can only be in one ` +
        `bridge. List the ports of all but one explicitly, or use one bridge with ` +
        `bridge-vlan sections.`
    );
  }

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

  // A VLAN on a port (eth1.10, a tagged internet line) uses the port itself:
  // left in a "*" bridge, the LAN would be bridged onto that line.
  const interfacedDevices = (resolvedOncConfig.network?.interface || [])
    .map((interface_) => interface_.device)
    .filter((device): device is string => typeof device === "string" && !!device)
    .flatMap((device) => [device, device.replace(/\.\d+$/, "")]);

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
                  // "*" / "*t": every port of the bridge, untagged / tagged.
                  // A list is taken as written. (It used to be repeated once
                  // per bridge port, nesting lists, so it never worked.)
                  ports: Array.isArray(resolvedSection.ports)
                    ? resolvedSection.ports
                    : getDevicePorts(resolvedSection.device).map((port) =>
                        resolvedSection.ports === "*t" ? `${port}:t` : port
                      ),
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
    // Radios are matched to config by band, so two radios in the same band
    // (tri-band hardware) share one config wifi-device. They still need
    // distinct section names, or the second overwrites the first in UCI.
    const wanted = wifiDevice?.[".name"] || sanitizeName(`wifidevice${index}`);
    const name = acc.some((d) => d[".name"] === wanted)
      ? sanitizeName(`${wanted}${index}`)
      : wanted;

    return [
      ...acc,
      {
        ...wifiDevice,
        ".name": name,
        channel: wifiDevice?.channel || defaultChannels[radio.band],
        type: radio.type,
        band: radio.band,
        ...(radio.path ? { path: radio.path } : { phy: radio.phy }),
        ...(radio.radio !== undefined ? { radio: radio.radio } : {}),
        htmode: resolveHtmode(wifiDevice?.htmode, radio.htmodes),
      },
    ];
  }, []);

  const { wifiInterfaces, wifiStations } = (
    resolvedOncConfig.wireless?.["wifi-iface"] || []
  ).reduce(
    (acc, { device, stations, ".name": base, ...wifiIface }, wifiIfaceIndex) => {
      const radioDeviceNames = wifiDevices.map((device) => device[".name"]);

      // A radio the config declares for a band this device does not have
      // (6 GHz on a dual-band access point) has no wifi-device here, so an
      // interface on it is skipped. A name nothing declares still goes
      // through, for netifd to report, rather than hiding a typo.
      const declaredElsewhere = (name: string) =>
        !radioDeviceNames.includes(name) &&
        (resolvedOncConfig.wireless?.["wifi-device"] || []).some(
          (d) => d[".name"] === name
        );
      const devices = (
        (typeof device === "string"
          ? device === "*"
            ? radioDeviceNames
            : [device]
          : device) || radioDeviceNames
      ).filter((name) => !declaredElsewhere(name));

      const interfaces = devices.map((deviceName, deviceIndex) => {
        return {
          // A named interface is one per radio: the radio's name is added.
          ".name": base
            ? `${base}_${sanitizeName(deviceName)}`
            : `wifinet${wifiIfaceIndex}${deviceIndex}`,
          device: deviceName,
          ...wifiIface,
        };
      });

      // Any-MAC wildcard so hostapd accepts the PSK from every client.
      // iface must be set: an empty wifi-station.iface matches every SSID.
      const stationSections = interfaces.flatMap((iface, deviceIndex) =>
        (stations || []).map((station, stationIndex) => ({
          ".name": base
            ? `${iface[".name"]}_key${stationIndex}`
            : `wifistation${wifiIfaceIndex}${deviceIndex}${stationIndex}`,
          iface: iface[".name"],
          key: station.key,
          mac: "00:00:00:00:00:00",
        }))
      );

      return {
        wifiInterfaces: [...acc.wifiInterfaces, ...interfaces],
        wifiStations: [...acc.wifiStations, ...stationSections],
      };
    },
    { wifiInterfaces: [] as any[], wifiStations: [] as any[] }
  );

  const final: OpenWrtConfig = {
    ...resolvedOpenWrtConfig,
    ...(radios.length > 0 && {
      wireless: {
        "wifi-device": wifiDevices,
        "wifi-iface": wifiInterfaces,
        ...(wifiStations.length > 0 && { "wifi-station": wifiStations }),
      },
    }),
  };

  // Two sections of one name would be merged by uci batch, silently.
  Object.entries(final as Record<string, Record<string, { ".name": string }[]>>).forEach(
    ([configKey, types]) => {
      const names = Object.values(types || {}).flatMap((sections) =>
        (sections || []).map((section) => section[".name"])
      );
      const repeated = names.filter((name, i) => names.indexOf(name) !== i);
      if (repeated.length > 0) {
        throw new Error(
          `${configKey}: more than one section named ${[...new Set(repeated)].join(", ")}`
        );
      }
    }
  );

  const openWrtConfig = parseSchema(openWrtConfigSchema, final);

  return openWrtConfig;
};
