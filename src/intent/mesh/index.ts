// The mesh, Wi-Fi backhaul between access points: this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { meshChecks } from "./checks";
import { mesh } from "./compile";
import { meshFields } from "./fields";
import { meshRules } from "./rules";

export const meshFeature: FeatureModule = { rules: meshRules, fields: meshFields, check: meshChecks, compile: [{ order: 90, compile: mesh }] };

export { meshNode } from "./compile";
export * from "./constants";
