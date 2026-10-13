import { resolveHtmode } from "./radioModes";
import { DeviceSchema } from "./deviceSchema";
import { ONCConfig, ONCDeviceConfig } from "./oncConfigSchema";
import { OpenWrtConfig, openWrtConfigSchema } from "./openWrtConfigSchema";
import { parseSchema } from "./utils";
import { resolveOncConfig } from "./resolveOncConfig";

/** A value with every string in it mapped, at any depth. */
const mapStrings = (value: unknown, fn: (text: string) => string): unknown =>
  typeof value === "string"
    ? fn(value)
    : Array.isArray(value)
    ? value.map((v) => mapStrings(v, fn))
    : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).map(([key, v]) => [key, mapStrings(v, fn)]))
    : value;

/** Every string in a value, at any depth. */
const stringsIn = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
    ? value.flatMap(stringsIn)
    : value && typeof value === "object"
    ? Object.values(value).flatMap(stringsIn)
    : [];

/** The lowest number from `from` up that `taken` does not hold. */
const firstFree = (taken: number[], from: number): number => (taken.includes(from) ? firstFree(taken, from + 1) : from);

const sanitizeName = (name: string) => name.replace(/[^0-9a-z]/gi, "");

/** "*" / "*t" in a port list: the free ports, untagged / tagged; other entries as written. */
const expandPorts = (list: string[], free: string[]) =>
  list.flatMap((port) => (port === "*" ? free : port === "*t" ? free.map((name) => `${name}:t`) : [port]));

// A channel of each band (6 GHz: its first preferred-scan channel; 60 GHz: 802.11ad's 2).
const defaultChannels = {
  "2g": 11,
  "5g": 36,
  "6g": 37,
  "60g": 2,
};

export const getOpenWrtConfig = ({
  oncConfig,
  deviceConfig,
  deviceSchema,
}: {
  oncConfig: ONCConfig;
  deviceConfig: ONCDeviceConfig;
  deviceSchema: DeviceSchema;
}) => {
  const { hostname } = deviceConfig;
  const useSwConfig = !!deviceSchema.sw_config;
  const ports = deviceSchema.ports || [];
  const cpuPort = ports.find((port) => !!port.sw_config_cpu_name);
  const cpu = () => {
    if (!cpuPort?.sw_config_cpu_name) throw new Error(`CPU port not defined`);
    return { port: cpuPort.name, device: cpuPort.sw_config_cpu_name };
  };
  const physicalPorts = ports.filter((port) => !port.sw_config_cpu_name);
  // On swconfig a port is the switch's (a switch VLAN reaches it, through the
  // CPU's device) or one beside it (a NIC of its own, used as on DSA).
  const onSwitch = (name: string) => useSwConfig && ports.some((p) => p.name === name && p.switch_port !== undefined);
  // A switch_vlan entry ("port2:t") as the switch lists it ("2t"); a number as written.
  const switchEntry = (entry: string) => {
    const [name, flags = ""] = entry.split(":");
    const port = ports.find((p) => p.name === name);
    if (port && port.switch_port === undefined) {
      throw new Error(`${hostname}: ${name} is not a port of the switch.`);
    }
    return `${port?.switch_port ?? name}${flags}`;
  };

  // A line's port, as any whole value: "@wan_port" (the port board.json
  // gives the WAN role, so a config can name it without knowing the model)
  // or "@port:eth2" (a port by name), each optionally with a VLAN (".10").
  // A port's own device on DSA, or beside a switch (eth1, eth1.10). On the
  // switch the line gets a switch VLAN of its own (its VLAN tagged, or a free
  // one untagged) on the port and the CPU, its device is the CPU's for that
  // VLAN (eth0.2), and the port leaves the networks' "*".
  const linePattern = /^@(?:wan_port|port:([A-Za-z0-9_-]+))(?:\.(\d+))?$/;
  const wanPortName = () => {
    const wan = physicalPorts.find((port) => port.default_role === "wan");
    if (!wan) throw new Error(`${hostname} has no WAN port for "@wan_port".`);
    return wan.name;
  };
  const lineOf = (value: unknown) => {
    const m = typeof value === "string" ? linePattern.exec(value) : null;
    return m ? { port: m[1] ?? wanPortName(), vlan: m[2] ? Number(m[2]) : undefined } : undefined;
  };
  const resolvedConditions = resolveOncConfig({ deviceConfig, deviceSchema, oncConfig });
  const lineRefs = stringsIn(resolvedConditions).flatMap((text) => lineOf(text) ?? []);
  lineRefs.forEach(({ port }) => {
    if (!physicalPorts.some((p) => p.name === port)) {
      throw new Error(`${hostname} has no port ${port} (it has ${physicalPorts.map((p) => p.name).join(", ")}).`);
    }
  });
  // Two lines on one port and VLAN (a connection on "@wan_port" and another
  // naming that port) would be two interfaces on one device: refused here,
  // where the WAN port is known.
  (resolvedConditions.network?.interface || []).reduce<Record<string, string>>((seen, iface: any) => {
    const line = lineOf(iface.device);
    if (!line) return seen;
    const key = `${line.port}${line.vlan ? `.${line.vlan}` : ""}`;
    if (seen[key]) throw new Error(`${hostname}: ${seen[key]} and ${iface[".name"]} are both on port ${key}.`);
    return { ...seen, [key]: iface[".name"] };
  }, {});
  // The switch: each line port's VLANs, its tagged ones, else a free one untagged.
  const networkSwitchVlans = resolvedConditions.network?.switch_vlan || [];
  const networkVlans = networkSwitchVlans.map((v) => Number(v.vlan));
  // Every tagged line first: on a switch one VLAN is one CPU device, so a
  // VLAN on two ports would join two lines (two providers) into one, and an
  // untagged line must not take a VLAN a tagged one has.
  const linePorts = [...new Set(lineRefs.map((r) => r.port))].filter(onSwitch);
  const taggedLines = linePorts.flatMap((port) =>
    [...new Set(lineRefs.filter((r) => r.port === port && r.vlan).map((r) => r.vlan!))].map((vlan) => ({ port, vlan, tagged: true }))
  );
  taggedLines.forEach(({ port, vlan }) => {
    if (networkVlans.includes(vlan)) {
      throw new Error(`${hostname}: VLAN ${vlan} is both a network's and the line's on ${port}.`);
    }
    const other = taggedLines.find((l) => l.vlan === vlan && l.port !== port);
    if (other) {
      throw new Error(`${hostname}: VLAN ${vlan} is on both ${port} and ${other.port}; on this switch that would join the two lines.`);
    }
  });
  const switchLines = linePorts
    .filter((port) => !taggedLines.some((l) => l.port === port))
    .reduce<{ port: string; vlan: number; tagged: boolean }[]>((acc, port) => {
      const taken = [...networkVlans, ...acc.map((l) => l.vlan)];
      const vlan = firstFree(taken, 2);
      return [...acc, { port, vlan, tagged: false }];
    }, taggedLines);
  const lineDevice = ({ port, vlan }: { port: string; vlan?: number }) => {
    if (!onSwitch(port)) return vlan ? `${port}.${vlan}` : port;
    // A bare port is its line: the untagged one, or its first tagged.
    const line = switchLines.find((l) => l.port === port && (vlan === undefined || l.vlan === vlan))!;
    return `${cpu().device}.${line.vlan}`;
  };
  // "@cpu_port" (".1"): the switch's CPU device, the one its VLANs reach.
  const cpuPattern = /^@cpu_port(?:\.(\d+))?$/;
  const withPlaceholders = (text: string) => {
    const line = lineOf(text);
    if (line) return lineDevice(line);
    const cpuRef = cpuPattern.exec(text);
    return cpuRef ? `${cpu().device}${cpuRef[1] ? `.${cpuRef[1]}` : ""}` : text;
  };
  const withLines = mapStrings(resolvedConditions, withPlaceholders) as typeof resolvedConditions;
  const resolvedOncConfig = switchLines.length
    ? {
        ...withLines,
        network: {
          ...withLines.network,
          switch_vlan: [
            ...(withLines.network?.switch_vlan || []),
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
  const network = resolvedOncConfig.network;

  // "*" means every physical port nothing else uses, and only explicit port
  // lists count as uses — so two "*" devices would each claim every free port,
  // and netifd would put each port in whichever it set up last. Resolved per
  // device, so "*" bridges whose .if never both apply are fine.
  // A list may hold "*" beside named ports (["*", "bat0"]): the same.
  const hasWildcard = (ports: unknown) => ports === "*" || (Array.isArray(ports) && ports.includes("*"));
  const wildcardDevices = (network?.device || []).filter((device) => hasWildcard(device.ports)).map((device) => device.name);
  if (wildcardDevices.length > 1) {
    const names = wildcardDevices.map((name) => `"${name}"`);
    throw new Error(
      `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} ${names.length === 2 ? "both" : "all"} use ` +
        `"ports": "*" on ${hostname}, but a port can only be in one ` +
        `bridge. List the ports of all but one explicitly, or use one bridge with ` +
        `bridge-vlan sections.`
    );
  }

  const bridgedDevices = (network?.device || [])
    .filter((device) => device.type === "bridge" && Array.isArray(device.ports))
    .flatMap((device) => (device.ports as string[]).filter((p) => p !== "*"));
  // A VLAN on a port (eth1.10, a tagged internet line) uses the port itself:
  // left in a "*" bridge, the LAN would be bridged onto that line.
  const interfacedDevices = (network?.interface || [])
    .map((iface) => iface.device)
    .filter((device): device is string => typeof device === "string" && !!device)
    .flatMap((device) => [device, device.replace(/\.\d+$/, "")]);
  const used = new Set([...bridgedDevices, ...interfacedDevices]);
  // What "*" takes: in a bridge, the free ports that are devices (all on
  // DSA, those beside the switch on swconfig); in a switch VLAN, the
  // switch's free ports, but never one untagged in another VLAN's list or
  // carrying a line.
  const freePorts = physicalPorts.filter((port) => !used.has(port.name) && !onSwitch(port.name)).map((p) => p.name);
  const untaggedOnSwitch = (network?.switch_vlan || [])
    .flatMap((v) => (Array.isArray(v.ports) ? v.ports : []))
    .filter((entry) => !entry.split(":")[1]?.includes("t"))
    .map(switchEntry);
  const freeSwitchPorts = physicalPorts
    .filter((port) => onSwitch(port.name) && !untaggedOnSwitch.includes(String(port.switch_port)))
    .filter((port) => !switchLines.some((l) => l.port === port.name))
    .map((p) => p.name);

  const requirePorts = <P>(section: { ports?: P }, what: string) => {
    if (section.ports === undefined) throw new Error(`${hostname}: a ${what} without ports.`);
    return section.ports;
  };
  const devicePorts = (ports: string | string[] | undefined) =>
    ports === undefined ? [] : expandPorts(typeof ports === "string" ? [ports] : ports, freePorts);
  const bridgePorts = (name: string) => devicePorts((network?.device || []).find((d) => d.name === name)?.ports);
  // "*" / "*t" alone: every port of the bridge, untagged / tagged. In a
  // list, the free physical ports only (a VLAN for cables alone, not the
  // bridge's other members such as the mesh), beside ports named as written.
  const bridgeVlanPorts = (section: { device: string; ports?: string | string[] }) => {
    const ports = requirePorts(section, "bridge-vlan");
    return Array.isArray(ports)
      ? expandPorts(ports, freePorts)
      : bridgePorts(section.device).map((port) => (ports === "*t" ? `${port}:t` : port));
  };
  // The CPU tagged, then the ports: "*" / "*t" (alone or in a list) the free ones.
  const switchVlanPorts = (section: { ports?: string | string[] }) => {
    const ports = requirePorts(section, "switch_vlan");
    return [`${cpu().port}:t`, ...expandPorts(typeof ports === "string" ? [ports] : ports, freeSwitchPorts)]
      .map(switchEntry)
      .join(" ");
  };

  // A device section named "@bridge_ports" is one per physical port of the
  // "*" bridge (a setting every one of them needs: the wired mesh's MTU),
  // each named for its port.
  const withPortDevices = {
    ...resolvedOncConfig,
    ...(network
      ? {
          network: {
            ...network,
            device: (network.device || []).flatMap((device: any) =>
              device.name === "@bridge_ports"
                ? freePorts.map((port) => ({
                    ...device,
                    ".name": `${device[".name"] ?? "port"}_${sanitizeName(port)}`,
                    name: port,
                  }))
                : [device]
            ),
          },
        }
      : {}),
  } as Record<string, Record<string, any[]>>;

  // What the engine works out per section: the hostname, and ports.
  const resolveSection = (configKey: string, sectionKey: string, section: any) =>
    configKey === "system" && sectionKey === "system"
      ? { hostname }
      : configKey !== "network"
      ? {}
      : sectionKey === "device"
      ? { ports: devicePorts(section.ports) }
      : sectionKey === "bridge-vlan" && !useSwConfig
      ? { ports: bridgeVlanPorts(section) }
      : sectionKey === "switch_vlan" && useSwConfig
      ? { ports: switchVlanPorts(section) }
      : {};

  const resolvedOpenWrtConfig = Object.fromEntries(
    Object.entries(withPortDevices)
      .filter(([configKey]) => configKey !== "wireless")
      .map(([configKey, types]) => [
        configKey,
        Object.fromEntries(
          Object.entries(types).map(([sectionKey, sections]) => [
            sectionKey,
            (sections || []).map(({ ".name": name, ...section }, index) => ({
              ".name": name || sanitizeName(`${sectionKey}${index}`),
              ...section,
              ...resolveSection(configKey, sectionKey, section),
            })),
          ])
        ),
      ])
  );

  // Each radio with its band's declared wifi-device: the first of a band by
  // that section's name, another (tri-band: two in 5 GHz) by the name and
  // its place, or uci would merge the two.
  const declaredRadios = resolvedOncConfig.wireless?.["wifi-device"] || [];
  const radios = (deviceSchema.radios || []).reduce<
    { radio: NonNullable<DeviceSchema["radios"]>[number]; declared?: (typeof declaredRadios)[number]; name: string; first: boolean }[]
  >((acc, radio, index) => {
    const declared = declaredRadios.find((d) => d.band === radio.band);
    const wanted = sanitizeName(declared?.[".name"] || `wifidevice${index}`);
    const first = !acc.some((r) => r.name === wanted);
    return [...acc, { radio, declared, name: first ? wanted : sanitizeName(`${wanted}${index}`), first }];
  }, []);
  const radioNames = radios.map((r) => r.name);

  // A declared radio's name stands for every radio of its band; an interface
  // with a name of its own (the mesh's ifname) is one device, so on the first
  // only. A radio declared for a band this device lacks (6 GHz on a dual-band
  // access point) has none here, so an interface on it is skipped. A name
  // nothing declares goes through, for netifd to report, rather than hiding
  // a typo.
  const radiosNamed = (name: string, single: boolean) => {
    const ofBand = radios.filter((r) => r.declared?.[".name"] === name).map((r) => r.name);
    return ofBand.length > 0
      ? ofBand.slice(0, single ? 1 : undefined)
      : radioNames.includes(name) || !declaredRadios.some((d) => d[".name"] === name)
      ? [name]
      : [];
  };

  const { wifiInterfaces, wifiStations } = (resolvedOncConfig.wireless?.["wifi-iface"] || []).reduce(
    (acc, { device, stations, ".name": base, ...wifiIface }, wifiIfaceIndex) => {
      const named = typeof device === "string" ? (device === "*" ? undefined : [device]) : device;
      const devices = named ? named.flatMap((name) => radiosNamed(name, !!wifiIface.ifname)) : radioNames;

      const interfaces = devices.map((deviceName, deviceIndex) => ({
        // A named interface is one per radio: the radio's name is added.
        ".name": base ? `${base}_${sanitizeName(deviceName)}` : `wifinet${wifiIfaceIndex}${deviceIndex}`,
        device: deviceName,
        ...wifiIface,
      }));

      // Any-MAC wildcard so hostapd accepts the PSK from every client.
      // iface must be set: an empty wifi-station.iface matches every SSID.
      const stationSections = interfaces.flatMap((iface, deviceIndex) =>
        (stations || []).map((station, stationIndex) => ({
          ".name": base ? `${iface[".name"]}_key${stationIndex}` : `wifistation${wifiIfaceIndex}${deviceIndex}${stationIndex}`,
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

  const wifiDevices = radios.map(({ radio, declared, name, first }) => ({
    ...declared,
    ".name": name,
    // A pinned channel (or the mesh's) is the first radio's of its band:
    // another there (tri-band's upper 5 GHz) may not have it.
    channel: first ? declared?.channel || defaultChannels[radio.band] : "auto",
    type: radio.type,
    band: radio.band,
    ...(radio.path ? { path: radio.path } : { phy: radio.phy }),
    ...(radio.radio !== undefined ? { radio: radio.radio } : {}),
    htmode: resolveHtmode(declared?.htmode, radio.htmodes),
    // Nothing declares it or uses it: off, rather than up with no country.
    ...(!declared && !wifiInterfaces.some((i) => i.device === name) ? { disabled: true } : {}),
  }));

  const final = {
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
  Object.entries(final as Record<string, Record<string, { ".name": string }[]>>).forEach(([configKey, types]) => {
    const names = Object.values(types || {}).flatMap((sections) => (sections || []).map((section) => section[".name"]));
    const repeated = names.filter((name, i) => names.indexOf(name) !== i);
    if (repeated.length > 0) {
      throw new Error(`${configKey}: more than one section named ${[...new Set(repeated)].join(", ")}`);
    }
  });

  return parseSchema(openWrtConfigSchema, final) as OpenWrtConfig;
};
