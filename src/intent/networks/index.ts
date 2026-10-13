// The networks (VLANs, DHCP, access, discovery, traffic): this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { networksChecks } from "./checks";
import { network } from "./compile";
import { discovery } from "./discovery";
import { networksFields } from "./fields";
import { networksRules } from "./rules";
import { traffic } from "./traffic";

export const networksFeature: FeatureModule = {
  rules: networksRules,
  fields: networksFields,
  check: networksChecks,
  compile: [
    { order: 30, compile: network },
    { order: 110, compile: discovery },
    { order: 120, compile: traffic },
  ],
};

export { deviceOf, poolStart } from "./compile";
export { reachableNetworks } from "./rules";
export { networkTemplates, templateOf, templateSettings, withTemplate } from "./templates";
export type { NetworkTemplate } from "./templates";
