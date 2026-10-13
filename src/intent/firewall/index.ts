// The firewall's exceptions (rules, port forwards): this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { firewallChecks } from "./checks";
import { firewall } from "./compile";
import { firewallFields } from "./fields";
import { firewallRules } from "./rules";

export const firewallFeature: FeatureModule = {
  rules: firewallRules,
  fields: firewallFields,
  check: firewallChecks,
  compile: [{ order: 50, compile: firewall }],
};
