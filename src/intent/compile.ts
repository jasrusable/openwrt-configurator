// Intent -> the low-level config the engine provisions. Pure: no device facts
// and no I/O, so the same intent always compiles to the same config, and
// everything device-specific is resolved later, against the live device.
import { devices } from "./features/devices";
import { dns } from "./features/dns";
import { internet } from "./features/internet";
import { network } from "./features/network";
import { roles } from "./features/roles";
import { system } from "./features/system";
import { wifi } from "./features/wifi";
import { Feature, merge } from "./fragment";
import { Intent, intentSchema } from "./schema";

/** In order: where two add sections of one type, earlier ones come first. */
const features: Feature[] = [
  devices,
  system,
  network,
  internet,
  dns,
  wifi,
  roles,
];

/** Unvalidated: the caller parses it with oncConfigSchema, like any config. */
export const compileIntent = (intent: Intent) =>
  merge(features.map((feature) => feature(intent)));

/** A parsed config file is an intent file if it says which intent schema it uses. */
export const isIntent = (json: unknown) =>
  !!json && typeof json === "object" && "schema" in json;

export { intentSchema };
