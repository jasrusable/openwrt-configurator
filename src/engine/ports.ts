// A device's ports, fitted: each line's port (the board's WAN port or one by
// name, a VLAN on it, a switch VLAN of its own on swconfig), the CPU's
// device, the ports nothing else uses ("free"), and each bridge's ports, as
// the resolved config's placeholders stood for them.
import { DeviceSchema } from "../deviceSchema";
import { isPlaceholder, Placeholder, Value } from "../plan/types";
import { ResolvedSection, ResolvedSections } from "./resolvePlan";
import { firstFree, mapPlaceholders, placeholdersIn, sanitizeName, strings, unresolvable as stuck } from "./values";

const allSections = (config: ResolvedSections) => Object.values(config).flatMap((types) => Object.values(types).flat());

/**
 * A device's resolved config with its port placeholders fitted (line ports,
 * the CPU's device, a device section per bridge port, the lines' switch
 * VLANs), and what its port lists become, section by section.
 */
export const fitPorts = ({
  hostname,
  deviceSchema,
  resolved,
}: {
  hostname: string;
  deviceSchema: DeviceSchema;
  resolved: ResolvedSections;
}): { config: ResolvedSections; portOptions: (configKey: string, type: string, s: ResolvedSection) => Record<string, Value> } => {
  const useSwConfig = !!deviceSchema.sw_config;
  const ports = deviceSchema.ports || [];
  const cpuPort = ports.find((port) => !!port.sw_config_cpu_name);
  const cpu = () => {
    if (!cpuPort?.sw_config_cpu_name) throw new Error(`${hostname}: its switch has no CPU port (board.json), so no network can reach it.`);
    return { port: cpuPort.name, device: cpuPort.sw_config_cpu_name };
  };
  const physicalPorts = ports.filter((port) => !port.sw_config_cpu_name);
  // The switch's own name (board.json's); facts read before it was kept: OpenWrt's usual.
  const switchName = deviceSchema.switch ?? "switch0";
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

  const network = resolved.network ?? {};

  // A line's port: the board's WAN port (so a config can name it without
  // knowing the model) or one by name, each optionally with a VLAN. A port's
  // own device on DSA, or beside a switch (eth1, eth1.10). On the switch the
  // line gets a switch VLAN of its own (its VLAN tagged, or a free one
  // untagged) on the port and the CPU, its device is the CPU's for that VLAN
  // (eth0.2), and the port leaves the networks' free ports.
  const wanPortName = () => {
    const wan = physicalPorts.find((port) => port.default_role === "wan");
    if (!wan) {
      throw new Error(`${hostname} has no WAN port (its board names none), so an internet line cannot use it: name the line's port, or make it an access point.`);
    }
    return wan.name;
  };
  const lineOf = (p: Placeholder) => (p.kind === "linePort" ? { port: p.port ?? wanPortName(), vlan: p.vlan } : undefined);
  const lineRefs = allSections(resolved).flatMap((s) =>
    Object.values(s.options).flatMap(placeholdersIn).flatMap((p) => lineOf(p) ?? [])
  );
  lineRefs.forEach(({ port }) => {
    if (!physicalPorts.some((p) => p.name === port)) {
      throw new Error(`${hostname} has no port ${port} (it has ${physicalPorts.map((p) => p.name).join(", ")}).`);
    }
  });
  // Two lines on one port and VLAN (a connection on the WAN port and another
  // naming that port) would be two interfaces on one device: refused here,
  // where the WAN port is known.
  (network.interface || []).reduce<Record<string, string | undefined>>((seen, iface) => {
    const device = iface.options.device;
    const line = isPlaceholder(device) ? lineOf(device) : undefined;
    if (!line) return seen;
    const key = `${line.port}${line.vlan ? `.${line.vlan}` : ""}`;
    if (seen[key]) throw new Error(`${hostname}: ${seen[key]} and ${iface.name} are both on port ${key}.`);
    return { ...seen, [key]: iface.name };
  }, {});
  // The switch: each line port's VLANs, its tagged ones, else a free one untagged.
  const networkSwitchVlans = network.switch_vlan || [];
  const networkVlans = networkSwitchVlans.map((v) => Number(v.options.vlan));
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
  // Line and CPU ports, and the switch, wherever they are: devices by name now.
  const withPorts = (value: Value) =>
    mapPlaceholders(value, (p) =>
      p.kind === "linePort"
        ? lineDevice(lineOf(p)!)
        : p.kind === "cpuPort"
          ? `${cpu().device}${p.vlan !== undefined ? `.${p.vlan}` : ""}`
          : p.kind === "switchName"
            ? switchName
            : p
    );
  const withLines: ResolvedSections = Object.fromEntries(
    Object.entries(resolved).map(([configKey, types]) => [
      configKey,
      Object.fromEntries(
        Object.entries(types).map(([type, sections]) => [
          type,
          sections.map((s) => ({ ...s, options: Object.fromEntries(Object.entries(s.options).map(([k, v]) => [k, withPorts(v)])) })),
        ])
      ),
    ])
  );
  const lineSwitchVlans: ResolvedSection[] = switchLines.map((l) => ({
    name: `line_${l.port}_${l.vlan}`,
    options: {
      device: switchName,
      vlan: l.vlan,
      ports: [`${l.port}${l.tagged ? ":t" : ""}`],
    },
  }));
  const net: Record<string, ResolvedSection[]> = {
    ...withLines.network,
    ...(switchLines.length ? { switch_vlan: [...(withLines.network?.switch_vlan || []), ...lineSwitchVlans] } : {}),
  };

  // The free ports, and only explicit port lists count as uses: so two
  // devices taking the free ports would each claim every one, and netifd
  // would put each port in whichever it set up last. Resolved per device,
  // so free-port bridges whose conditions never both apply are fine.
  const takesFree = (value: Value | undefined) =>
    value !== undefined && placeholdersIn(value).some((p) => p.kind === "freePorts" && !p.tagged);
  const wildcardDevices = (net.device || []).filter((d) => takesFree(d.options.ports)).map((d) => String(d.options.name));
  if (wildcardDevices.length > 1) {
    const names = wildcardDevices.map((name) => `"${name}"`);
    throw new Error(
      `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]} ${names.length === 2 ? "both" : "all"} use ` +
        `"ports": "*" on ${hostname}, but a port can only be in one ` +
        `bridge. List the ports of all but one explicitly, or use one bridge with ` +
        `bridge-vlan sections.`
    );
  }

  const bridgedDevices = (net.device || [])
    .filter((d) => d.options.type === "bridge" && Array.isArray(d.options.ports))
    .flatMap((d) => strings(d.options.ports));
  // A VLAN on a port (eth1.10, a tagged internet line) uses the port itself:
  // left in a free-port bridge, the LAN would be bridged onto that line.
  const interfacedDevices = (net.interface || [])
    .map((iface) => iface.options.device)
    .filter((device): device is string => typeof device === "string" && !!device)
    .flatMap((device) => [device, device.replace(/\.\d+$/, "")]);
  const used = new Set([...bridgedDevices, ...interfacedDevices]);
  // The free ports: in a bridge, the free ports that are devices (all on
  // DSA, those beside the switch on swconfig); in a switch VLAN, the
  // switch's free ports, but never one untagged in another VLAN's list or
  // carrying a line.
  const freePorts = physicalPorts.filter((port) => !used.has(port.name) && !onSwitch(port.name)).map((p) => p.name);
  const untaggedOnSwitch = (net.switch_vlan || [])
    .flatMap((v) => (Array.isArray(v.options.ports) ? strings(v.options.ports) : []))
    .filter((entry) => !entry.split(":")[1]?.includes("t"))
    .map(switchEntry);
  const freeSwitchPorts = physicalPorts
    .filter((port) => onSwitch(port.name) && !untaggedOnSwitch.includes(String(port.switch_port)))
    .filter((port) => !switchLines.some((l) => l.port === port.name))
    .map((p) => p.name);

  /** A port list's free ports, untagged or tagged, as the names they stand for. */
  const expanded = (value: Value, free: string[]): string[] =>
    strings(
      mapPlaceholders(value, (p) =>
        p.kind === "freePorts" ? (p.tagged ? free.map((name) => `${name}:t`) : free) : unresolvable(p)
      )
    );
  const unresolvable = stuck(hostname);
  const requirePorts = (section: ResolvedSection, what: string) => {
    if (section.options.ports === undefined) throw new Error(`${hostname}: a ${what} without ports.`);
    return section.options.ports;
  };
  const devicePorts = (ports: Value | undefined) => (ports === undefined ? [] : expanded(ports, freePorts));
  const bridgePorts = (name: Value | undefined) => devicePorts((net.device || []).find((d) => d.options.name === name)?.options.ports);
  // A whole list of the bridge's ports: every one, untagged or tagged. In a
  // list, the free physical ports only (a VLAN for cables alone, not the
  // bridge's other members such as the mesh), beside ports named as written.
  const bridgeVlanPorts = (section: ResolvedSection) => {
    const ports = requirePorts(section, "bridge-vlan");
    return isPlaceholder(ports) && ports.kind === "bridgePorts"
      ? bridgePorts(section.options.device).map((port) => (ports.tagged ? `${port}:t` : port))
      : expanded(ports, freePorts);
  };
  // The CPU tagged, then the ports, the free ones in place of the placeholder.
  const switchVlanPorts = (section: ResolvedSection) =>
    [`${cpu().port}:t`, ...expanded(requirePorts(section, "switch_vlan"), freeSwitchPorts)].map(switchEntry).join(" ");

  // A device section named for each port of the free-port bridge (a setting
  // every one of them needs: the wired mesh's MTU), each named for its port.
  const devices = (net.device || []).flatMap((d) =>
    isPlaceholder(d.options.name) && d.options.name.kind === "eachBridgePort"
      ? freePorts.map((port) => ({ name: `${d.name ?? "port"}_${sanitizeName(port)}`, options: { ...d.options, name: port } }))
      : [d]
  );
  const withPortDevices: ResolvedSections = { ...withLines, ...(withLines.network ? { network: { ...net, device: devices } } : {}) };

  // What the ports make of each section: a device's, a VLAN's or a switch VLAN's port list.
  const portOptions = (configKey: string, type: string, s: ResolvedSection): Record<string, Value> =>
    configKey !== "network"
      ? {}
      : type === "device"
          ? { ports: devicePorts(s.options.ports) }
          : type === "bridge-vlan" && !useSwConfig
            ? { ports: bridgeVlanPorts(s) }
            : type === "switch_vlan" && useSwConfig
              ? { ports: switchVlanPorts(s) }
              : {};

  return { config: withPortDevices, portOptions };
};
