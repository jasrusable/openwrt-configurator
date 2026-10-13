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

  // A line's port, as any whole value: "@wan_port" (the port board.json
  // gives the WAN role, so a config can name it without knowing the model)
  // or "@port:eth2" (a port by name), each optionally with a VLAN (".10").
  // On DSA that is the port's own device (eth1, eth1.10). On swconfig the
  // ports are a switch's, behind one CPU device: the line gets a switch VLAN
  // of its own (its VLAN tagged, or a free one untagged) on the port and the
  // CPU, its device is the CPU's for that VLAN (eth0.2), and the port leaves
  // the networks' "*". A placeholder rather than a name, as a switch port's
  // name can be the CPU device's (eth0 on eth0.2).
  const linePattern = /^@(?:wan_port|port:([A-Za-z0-9_-]+))(?:\.(\d+))?$/;
  const wanPortName = () => {
    const wan = physicalPorts.find((port) => port.default_role === "wan");
    if (!wan) throw new Error(`${deviceConfig.hostname} has no WAN port for "@wan_port".`);
    return wan.name;
  };
  const lineRefs: { port: string; vlan?: number }[] = [];
  const collectLines = (value: unknown): void => {
    const m = typeof value === "string" ? linePattern.exec(value) : null;
    if (m) lineRefs.push({ port: m[1] ?? wanPortName(), ...(m[2] ? { vlan: Number(m[2]) } : {}) });
    else if (Array.isArray(value)) value.forEach(collectLines);
    else if (value && typeof value === "object") Object.values(value).forEach(collectLines);
  };
  const resolvedConditions = resolveOncConfig({ deviceConfig, deviceSchema, oncConfig });
  collectLines(resolvedConditions);
  lineRefs.forEach(({ port }) => {
    if (!physicalPorts.some((p) => p.name === port)) {
      throw new Error(`${deviceConfig.hostname} has no port ${port} (it has ${physicalPorts.map((p) => p.name).join(", ")}).`);
    }
  });
  // Two lines on one port and VLAN (a connection on "@wan_port" and another
  // naming that port) would be two interfaces on one device: refused here,
  // where the WAN port is known.
  (resolvedConditions.network?.interface || []).reduce<Record<string, string>>((seen, iface: any) => {
    const m = typeof iface.device === "string" ? linePattern.exec(iface.device) : null;
    if (!m) return seen;
    const key = `${m[1] ?? wanPortName()}.${m[2] ?? ""}`;
    if (seen[key]) {
      throw new Error(`${deviceConfig.hostname}: ${seen[key]} and ${iface[".name"]} are both on port ${key.replace(/\.$/, "")}.`);
    }
    return { ...seen, [key]: iface[".name"] };
  }, {});
  // swconfig: each line port's VLANs: its tagged ones, else a free one untagged.
  const networkSwitchVlans = resolvedConditions.network?.switch_vlan || [];
  const networkVlans = networkSwitchVlans.map((v) => Number(v.vlan));
  // Every tagged line first: on a switch one VLAN is one CPU device, so a
  // VLAN on two ports would join two lines (two providers) into one, and an
  // untagged line must not take a VLAN a tagged one has.
  const linePorts = [...new Set(lineRefs.map((r) => r.port))];
  const taggedLines = useSwConfig
    ? linePorts.flatMap((port) =>
        [...new Set(lineRefs.filter((r) => r.port === port && r.vlan).map((r) => r.vlan!))].map((vlan) => ({ port, vlan, tagged: true }))
      )
    : [];
  taggedLines.forEach(({ port, vlan }) => {
    if (networkVlans.includes(vlan)) {
      throw new Error(`${deviceConfig.hostname}: VLAN ${vlan} is both a network's and the line's on ${port}.`);
    }
    const other = taggedLines.find((l) => l.vlan === vlan && l.port !== port);
    if (other) {
      throw new Error(`${deviceConfig.hostname}: VLAN ${vlan} is on both ${port} and ${other.port}; on this switch that would join the two lines.`);
    }
  });
  const switchLines = useSwConfig
    ? linePorts
        .filter((port) => !taggedLines.some((l) => l.port === port))
        .reduce<{ port: string; vlan: number; tagged: boolean }[]>((acc, port) => {
          const taken = [...networkVlans, ...acc.map((l) => l.vlan)];
          let vlan = 2;
          while (taken.includes(vlan)) vlan++;
          return [...acc, { port, vlan, tagged: false }];
        }, taggedLines)
    : [];
  const lineDevice = (port: string, vlan?: number) => {
    if (!useSwConfig) return vlan ? `${port}.${vlan}` : port;
    // A bare port is its line: the untagged one, or its first tagged.
    const line = switchLines.find((l) => l.port === port && (vlan === undefined || l.vlan === vlan))!;
    return `${expectCpuPort().sw_config_cpu_name}.${line.vlan}`;
  };
  const withLinePorts = (value: unknown): unknown => {
    const m = typeof value === "string" ? linePattern.exec(value) : null;
    return m
      ? lineDevice(m[1] ?? wanPortName(), m[2] ? Number(m[2]) : undefined)
      : Array.isArray(value)
      ? value.map(withLinePorts)
      : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, withLinePorts(v)]))
      : value;
  };
  const withLines = withLinePorts(resolvedConditions) as ReturnType<typeof resolveOncConfig>;
  const resolvedOncConfig = switchLines.length
    ? {
        ...withLines,
        network: {
          ...withLines.network,
          switch_vlan: [
            ...networkSwitchVlans,
            ...switchLines.map((l) => ({
              ".name": `line_${l.port}_${l.vlan}`,
              device: networkSwitchVlans[0]?.device ?? "switch0",
              vlan: l.vlan,
              ports: [`${l.port}${l.tagged ? ":t" : ""}`],
            })),
          ],
        },
      }
    : withLines;

  // "*" means every physical port nothing else uses, and only explicit port
  // lists count as uses — so two "*" devices would each claim every free port,
  // and netifd would put each port in whichever it set up last. Resolved per
  // device, so "*" bridges whose .if never both apply are fine.
  // A list may hold "*" beside named ports (["*", "bat0"]): the same.
  const hasWildcard = (ports: unknown) => ports === "*" || (Array.isArray(ports) && ports.includes("*"));
  const wildcardDevices = (resolvedOncConfig.network?.device || [])
    .filter((device) => hasWildcard(device.ports))
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
      const devices = (Array.isArray(device.ports) ? device.ports.filter((p: string) => p !== "*") : []).map(
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

  // A line's port is its own switch VLAN's, never the networks'.
  const swConfigPortsWhichCanBeUntagged = physicalPorts.filter(
    (port) => !swConfigUntaggedPortNames.includes(port.name) && !switchLines.some((l) => l.port === port.name)
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
        : deviceSection.ports.flatMap((port: string) =>
            port === "*" ? unusedPhysicalPorts.map((p) => p.name) : [port]
          )
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

  // A device section named "@bridge_ports" is one per physical port of the
  // "*" bridge (a setting every one of them needs: the wired mesh's MTU),
  // each named for its port.
  const withPortDevices = {
    ...resolvedOncConfig,
    ...(resolvedOncConfig.network
      ? {
          network: {
            ...resolvedOncConfig.network,
            device: (resolvedOncConfig.network.device || []).flatMap((device: any) =>
              device.name === "@bridge_ports"
                ? unusedPhysicalPorts.map((port) => ({
                    ...device,
                    ".name": `${device[".name"] ?? "port"}_${sanitizeName(port.name)}`,
                    name: port.name,
                  }))
                : [device]
            ),
          },
        }
      : {}),
  };

  const resolvedOpenWrtConfig = Object.keys(withPortDevices)
    .filter((key) => key !== "wireless")
    .reduce((config, configKey) => {
      const resolvedConfig = Object.keys(
        (withPortDevices as any)[configKey]
      ).reduce((section, sectionKey) => {
        const sections: any[] =
          (withPortDevices as any)[configKey][sectionKey] || [];
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
                  // In a list, "*" / "*t" are the free physical ports only (a
                  // VLAN for cables alone, not the bridge's other members such
                  // as the mesh), beside ports named as written.
                  ports: Array.isArray(resolvedSection.ports)
                    ? resolvedSection.ports.flatMap((port: string) =>
                        port === "*" || port === "*t"
                          ? unusedPhysicalPorts.map((p) => (port === "*t" ? `${p.name}:t` : p.name))
                          : [port]
                      )
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

  // A channel of each band (6 GHz: its first preferred-scan channel; 60 GHz: 802.11ad's 2).
  const defaultChannels = {
    "2g": 11,
    "5g": 36,
    "6g": 37,
    "60g": 2,
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
