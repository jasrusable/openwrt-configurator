// Every feature module, the one list of them, in order: their rules, fields
// and checks make the registries (choices.ts, fields.ts, schema.ts), and
// their compile steps the plan (compile.ts, in each step's own order). Where
// two rules are about one setting, the earlier feature's reason is the one
// given, so a feature whose rules hold others' settings to its own (the
// mesh) comes after them.
import { dnsFeature } from "./dns";
import type { FeatureModule } from "./feature";
import { firewallFeature } from "./firewall";
import { hardwareFeature } from "./hardware";
import { internetFeature } from "./internet";
import { meshFeature } from "./mesh";
import { networksFeature } from "./networks";
import { patchesFeature } from "./patches";
import { systemFeature } from "./system";
import { vpnFeature } from "./vpn";
import { wifiFeature } from "./wifi";

export const featureModules: FeatureModule[] = [
  systemFeature,
  hardwareFeature,
  internetFeature,
  networksFeature,
  wifiFeature,
  meshFeature,
  firewallFeature,
  vpnFeature,
  dnsFeature,
  patchesFeature,
];
