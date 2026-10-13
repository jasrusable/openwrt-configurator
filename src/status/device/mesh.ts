// The mesh: batman-adv's routes to each node, and the wired mesh's MTU and
// path check.
import type { DeviceSchema } from "../../deviceSchema";
import type { Probe } from "../../deviceProbes";
import { meshWiredVlan } from "../../intent/radios";
import type { MeshNeighbour } from "./types";

/**
 * Where a node runs the mesh over cables, and what carries its frames: on
 * DSA the bridge's VLAN (`br-lan.4000`) over the bridge's ports; on swconfig
 * the CPU's own VLAN device (`eth0.4000`, the switch carrying the VLAN
 * tagged), over the CPU's device, as the switch's ports are not Linux
 * devices (src/intent/mesh/compile.ts makes both).
 */
export type MeshWiredLink = {
  device: string;
  carriers: string;
  /** Whether it is set to carry batman's larger frames: DSA's are; a switch's never (it splits them). */
  large: boolean;
};

export const meshWiredLink = (schema: DeviceSchema | undefined): MeshWiredLink | undefined => {
  if (!schema?.sw_config) return { device: `br-lan.${meshWiredVlan}`, carriers: "/sys/class/net/br-lan/brif/*", large: true };
  const cpu = schema.ports?.find((p) => p.sw_config_cpu_name)?.sw_config_cpu_name;
  return cpu && /^[A-Za-z0-9._@-]+$/.test(cpu) ? { device: `${cpu}.${meshWiredVlan}`, carriers: `/sys/class/net/${cpu}`, large: false } : undefined;
};

/**
 * See DeviceStatus.meshWiredMtu and meshWiredPath: "<mtu> <small> <large>".
 * The large ping fills the MTU exactly (IPv6 and ICMP take 48 bytes).
 */
export const meshWired = ({ device, carriers }: Pick<MeshWiredLink, "device" | "carriers">): Probe<{ mtu: number; small: number; large: number } | undefined> => ({
  command: [
    `d=/sys/class/net/${device}; [ -e $d ] || exit 0`,
    `m=$(cat $d/mtu); for i in ${carriers}; do n=\${i##*/}; [ "$n" = bat0 ] && continue; v=$(cat /sys/class/net/$n/mtu); [ "$v" -lt "$m" ] && m=$v; done`,
    `heard() { ping -6 -c 1 -W 1 -I ${device} "$@" ff02::1 2>/dev/null | grep -o "from [0-9a-f:]*" | sort -u | grep -c .; }`,
    'echo "$m $(heard) $(heard -s $(($m - 48)))"',
  ].join("; "),
  parse: ({ stdout }) => {
    const m = /^(\d+) (\d+) (\d+)$/.exec(stdout.trim());
    return m ? { mtu: Number(m[1]), small: Number(m[2]), large: Number(m[3]) } : undefined;
  },
});

/** batman-adv's originator table, without its header; nothing where batman does not run. */
export const originators: Probe<string> = {
  command: "batctl meshif bat0 originators -H 2>/dev/null || true",
  parse: ({ stdout }) => stdout,
};

/**
 * The best route (marked *) to each originator in `batctl o -H`, through
 * which neighbour. A line reads
 * " * 02:aa:bb:cc:dd:01    0.420s   ( 54.0) 02:aa:bb:cc:dd:01 [     mesh0]";
 * the throughput in Mbit/s, as BATMAN_V (the compiler's) prints it.
 */
export const parseRoutes = (text: string) =>
  text.split("\n").flatMap((line) => {
    const m = /^\s*\*\s*([0-9a-f:]{17})\s+([\d.]+)s\s+\(\s*([\d.]+)\)\s+([0-9a-f:]{17})/i.exec(line);
    return m
      ? [
          {
            originator: m[1].toLowerCase(),
            nexthop: m[4].toLowerCase(),
            throughput: Number(m[3]),
            lastSeen: Number(m[2]),
          },
        ]
      : [];
  });

/**
 * Every node's best route. Which are direct neighbours is decided with the
 * devices' MACs (networkStatus): a node with several interfaces (the mesh,
 * a cable) is known by its first, while its next hop is the one on the link.
 */
export const parseOriginators = (text: string): MeshNeighbour[] =>
  parseRoutes(text).map((r) => ({ originator: r.originator, mac: r.nexthop, throughput: r.throughput, lastSeen: r.lastSeen }));
