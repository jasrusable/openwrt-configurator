// System (the site's name, time, logins): this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { systemChecks } from "./checks";
import { system } from "./compile";
import { systemFields } from "./fields";
import { systemRules } from "./rules";

export const systemFeature: FeatureModule = {
  rules: systemRules,
  fields: systemFields,
  check: systemChecks,
  compile: [{ order: 20, compile: system }],
};

export { sshLogin } from "./compile";

export { countries } from "./countries";
export { timezones } from "./timezones";
