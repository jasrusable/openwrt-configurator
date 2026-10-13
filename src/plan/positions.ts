// Where each placeholder may stand, by option (`config.type.option`) and as
// the whole value or an item of a list. One table for the engine's meaning,
// the plan check (src/plan/check.ts) and the low-level JSON's reading and
// printing (src/lowLevel/placeholders.ts), so a plan printed and read back
// is the same plan.
import { Placeholder } from "./types";

const portLists = ["network.device.ports", "network.bridge-vlan.ports", "network.switch_vlan.ports"];

/** Whether `p` means something at option `at`, as the whole value (`whole`) or a list item. */
export const placeholderFits = (p: Placeholder, at: string, whole: boolean): boolean => {
  switch (p.kind) {
    // A device by name: wherever one may be named.
    case "linePort":
    case "cpuPort":
      return true;
    // In a port list; as a whole list only where it reads so ("ports": "*").
    case "freePorts":
      return (
        portLists.includes(at) &&
        (!whole || at === "network.switch_vlan.ports" || (at === "network.device.ports" && !p.tagged))
      );
    // A bridge VLAN's whole list: every port of its bridge.
    case "bridgePorts":
      return whole && at === "network.bridge-vlan.ports";
    case "eachBridgePort":
      return whole && at === "network.device.name";
    // The switch, where a section names it.
    case "switchName":
      return whole && (at === "network.switch.name" || at === "network.switch_vlan.device");
    case "allRadios":
      return whole && at === "wireless.wifi-iface.device";
    case "spareRadios":
      return !whole && at === "wireless.wifi-iface.device";
    case "bestMode":
      return whole && at === "wireless.wifi-device.htmode";
    case "stations":
      return whole && at === "wireless.wifi-iface.stations";
  }
};

/** Where a placeholder may not stand, in words, or undefined where it fits. */
export const placeholderProblem = (p: Placeholder, at: string, whole: boolean) =>
  placeholderFits(p, at, whole) ? undefined : `a ${p.kind} placeholder cannot stand ${whole ? "as" : "in"} ${at}`;
