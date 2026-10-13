// Wi-Fi (SSIDs, radios, roaming, airtime): this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { airtime } from "./airtime";
import { wifiChecks } from "./checks";
import { wifi } from "./compile";
import { wifiFields } from "./fields";
import { wifiRules } from "./rules";

export const wifiFeature: FeatureModule = {
  rules: wifiRules,
  fields: wifiFields,
  check: wifiChecks,
  compile: [
    { order: 70, compile: wifi },
    { order: 80, compile: airtime },
  ],
};

export { aqlLimits, txpower } from "./constants";
export * from "./roaming";
