// Intent -> the low-level config the engine provisions. Pure: no device facts
// and no I/O, so the same intent always compiles to the same config, and
// everything device-specific is resolved later, against the live device.
import { airtime } from "./features/airtime";
import { devices } from "./features/devices";
import { discovery } from "./features/discovery";
import { dns } from "./features/dns";
import { firewall } from "./features/firewall";
import { internet } from "./features/internet";
import { mesh } from "./features/mesh";
import { vpn } from "./features/vpn";
import { network } from "./features/network";
import { roles } from "./features/roles";
import { system } from "./features/system";
import { traffic } from "./features/traffic";
import { wifi } from "./features/wifi";
import { Feature, merge } from "./fragment";
import { patchesFeature } from "./patches";
import { Intent, intentSchema } from "./schema";

/** In order: where two add sections of one type, earlier ones come first. */
const features: Feature[] = [
  devices,
  system,
  network,
  internet,
  firewall,
  dns,
  wifi,
  airtime,
  mesh,
  vpn,
  discovery,
  traffic,
  roles,
  // Last: fixes layered over everything else (src/intent/patches).
  patchesFeature,
];

/** Unvalidated: the caller parses it with oncConfigSchema, like any config. */
export const compileIntent = (intent: Intent) =>
  merge(features.map((feature) => feature(intent)));

/** A parsed config file is an intent file if it says which intent schema it uses. */
export const isIntent = (json: unknown) =>
  !!json && typeof json === "object" && "schema" in json;

export { intentSchema };
