// The routers and access points: this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { devices, roles } from "./compile";
import { hardwareFields } from "./fields";
import { hardwareRules } from "./rules";

export const hardwareFeature: FeatureModule = {
  rules: hardwareRules,
  fields: hardwareFields,
  compile: [
    { order: 10, compile: devices },
    { order: 130, compile: roles },
  ],
};
