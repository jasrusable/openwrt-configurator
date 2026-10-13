// What a condition asks of one device: its tags and name from the plan,
// its model, release, switch and radios from its facts.
import { DeviceSchema } from "../deviceSchema";
import { PlanDevice } from "./types";
import { evaluateChecked, isFact, Lookup, unknownFactMessage, When } from "./when";

export const deviceLookup = (device: PlanDevice, schema: DeviceSchema): Lookup => {
  const radios = schema.radios ?? [];
  const builtIn: Record<string, string | boolean | undefined> = {
    "device.sw_config": schema.sw_config,
    "device.hostname": device.hostname,
    "device.ipaddr": device.ipaddr,
    "device.model_id": device.modelId ?? schema.name,
    "device.version": schema.version,
    // Whether it has a radio in each band: for config only a radio there can
    // carry (a mesh on a router that may or may not have Wi-Fi).
    ...Object.fromEntries(["2g", "5g", "6g"].map((band) => [`device.wifi_${band}`, radios.some((r) => r.band === band)])),
    // And one there that can mesh (802.11s; unknown counts as yes, as facts
    // read before it was asked do not say).
    ...Object.fromEntries(
      ["2g", "5g", "6g"].map((band) => [`device.mesh_${band}`, radios.some((r) => r.band === band && r.mesh !== false)])
    ),
  };
  return (name) => {
    if (!isFact(name)) throw new Error(unknownFactMessage(name));
    // A tag this device does not set is absent, not an error: conditions
    // are shared by every device, and not every device sets every tag.
    if (name.startsWith("device.tag.")) return { value: device.tags[name.slice("device.tag.".length)] };
    return { value: builtIn[name] };
  };
};

/** Whether a declaration with this condition applies to the device (none: always). */
export const appliesTo = (condition: When | undefined, lookup: Lookup) => !condition || evaluateChecked(condition, lookup);
