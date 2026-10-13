// The internet lines: this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { internetChecks } from "./checks";
import { internet } from "./compile";
import { internetFields } from "./fields";
import { internetRules } from "./rules";

export const internetFeature: FeatureModule = {
  rules: internetRules,
  fields: internetFields,
  check: internetChecks,
  compile: [{ order: 40, compile: internet }],
};

export { ddnsService } from "./compile";
export { ddnsCheckMinutes } from "./constants";
