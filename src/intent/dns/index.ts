// DNS (upstream, local names): this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { dnsChecks } from "./checks";
import { dns } from "./compile";

export { dohPorts, fallbackOf, providerLabels } from "./compile";
import { dnsFields } from "./fields";
import { dnsRules } from "./rules";

export const dnsFeature: FeatureModule = { rules: dnsRules, fields: dnsFields, check: dnsChecks, compile: [{ order: 60, compile: dns }] };
