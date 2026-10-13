// VPN (remote access, linked sites, providers): this feature's one public surface. The registries take its
// module (rules, fields, checks, and its compile steps, each with its place
// among all the features'); other code imports what it needs from here, never
// from the folder's own files. Its schema slice (schema.ts) is assembled by
// the root schema.
import type { FeatureModule } from "../feature";
import { vpnChecks } from "./checks";
import { vpn } from "./compile";
import { vpnFields } from "./fields";
import { vpnRules } from "./rules";

export const vpnFeature: FeatureModule = { rules: vpnRules, fields: vpnFields, check: vpnChecks, compile: [{ order: 100, compile: vpn }] };

export { ovpnFile } from "./compile";
export * from "./model";
export { ovpnUnsafe } from "./ovpn";
