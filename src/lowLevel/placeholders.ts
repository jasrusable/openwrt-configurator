// Placeholders as the low-level JSON writes them, read and printed by one
// table (src/plan/positions.ts says where each may stand), so a plan
// printed and read back is the same plan:
//
//   "@wan_port", "@port:eth2", "@port:eth2.10"  a line's port (anywhere)
//   "@cpu_port", "@cpu_port.1"                 the switch's CPU device (anywhere)
//   "*", "*t"                                  free ports (in a port list), a bridge VLAN's
//                                              whole port list, every radio (a Wi-Fi interface's device)
//   "@bridge_ports"                            one device section per bridge port (a device's name)
//   "@best/80"                                 a radio's best mode up to a width (its htmode)
//
// A plain text that would read as one is written with a second "@"
// ("@@wan_port" is the text "@wan_port"); a plain "*" or "*t" where it
// would read as one cannot be written at all.
import { placeholderFits } from "../plan/positions";
import { Placeholder, Scalar } from "../plan/types";

const portPattern = /^@(?:wan_port|port:([A-Za-z0-9_-]+))(?:\.(\d+))?$/;
const cpuPattern = /^@cpu_port(?:\.(\d+))?$/;
const bestPattern = /^@best\/(\d+)$/;

/** What a text could stand for, before asking whether it may stand there. */
const candidate = (at: string, text: string, whole: boolean): Placeholder | undefined => {
  const line = portPattern.exec(text);
  if (line) return { kind: "linePort", ...(line[1] ? { port: line[1] } : {}), ...(line[2] ? { vlan: Number(line[2]) } : {}) };
  const cpu = cpuPattern.exec(text);
  if (cpu) return { kind: "cpuPort", ...(cpu[1] ? { vlan: Number(cpu[1]) } : {}) };
  const best = bestPattern.exec(text);
  if (best) return { kind: "bestMode", width: Number(best[1]) };
  if (text === "@bridge_ports") return { kind: "eachBridgePort" };
  if (text === "*" || text === "*t") {
    const tagged = text === "*t";
    if (whole && at === "network.bridge-vlan.ports") return { kind: "bridgePorts", tagged };
    if (whole && at === "wireless.wifi-iface.device" && !tagged) return { kind: "allRadios" };
    return { kind: "freePorts", tagged };
  }
  return undefined;
};

/** A text at option `at` (the whole value, or a list item): the placeholder it stands for there, or itself. */
export const readText = (at: string, text: string, whole: boolean): Scalar | Placeholder => {
  if (text.startsWith("@@")) return text.slice(1);
  const p = candidate(at, text, whole);
  return p && placeholderFits(p, at, whole) ? p : text;
};

/** A placeholder as written at `at`; one that cannot stand there is a bug in whatever made the plan. */
export const writePlaceholder = (at: string, p: Placeholder, whole: boolean): string | { key: string }[] => {
  if (!placeholderFits(p, at, whole)) throw new Error(`A ${p.kind} placeholder cannot stand ${whole ? "as" : "in"} ${at}.`);
  switch (p.kind) {
    case "linePort":
      return `${p.port ? `@port:${p.port}` : "@wan_port"}${p.vlan !== undefined ? `.${p.vlan}` : ""}`;
    case "cpuPort":
      return `@cpu_port${p.vlan !== undefined ? `.${p.vlan}` : ""}`;
    case "freePorts":
    case "bridgePorts":
      return p.tagged ? "*t" : "*";
    case "eachBridgePort":
      return "@bridge_ports";
    case "allRadios":
      return "*";
    case "bestMode":
      return `@best/${p.width}`;
    case "stations":
      return p.keys.map((key) => ({ key }));
  }
};

/** A plain text as written at `at`: escaped where it would read as a placeholder. */
export const writeText = (at: string, text: string, whole: boolean): string => {
  if (text.startsWith("@") && (text.startsWith("@@") || readText(at, text, whole) !== text)) return `@${text}`;
  if (readText(at, text, whole) !== text) throw new Error(`The text ${JSON.stringify(text)} cannot be written as ${at}: it reads as a placeholder there.`);
  return text;
};
