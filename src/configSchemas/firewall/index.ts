import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
  onlySectionTypes,
} from "../../utils";
import { firewallDefaultsSchema, oncFirewallDefaultsSchema } from "./default";
import {
  firewallForwardingSchema,
  oncFirewallForwardingSchema,
} from "./forwarding";
import {
  firewallRedirectSchema,
  oncFirewallRedirectSchema,
} from "./redirect";
import { firewallRuleSchema, oncFirewallRuleSchema } from "./rule";
import { firewallZoneSchema, oncFirewallZoneSchema } from "./zone";

// OpenWrt's firewall section types.
const knownTypes = onlySectionTypes(["defaults", "zone", "forwarding", "rule", "redirect", "include", "ipset", "nat"]);

export const firewallSchema = configSchema(
  z
    .object({
      defaults: sectionSchema(firewallDefaultsSchema),
      zone: sectionSchema(firewallZoneSchema),
      forwarding: sectionSchema(firewallForwardingSchema),
      rule: sectionSchema(firewallRuleSchema),
      redirect: sectionSchema(firewallRedirectSchema),
    })
    .passthrough()
).superRefine(knownTypes);

export const oncFirewallSchema = makeOncConfigSchema(
  z
    .object({
      defaults: oncSectionSchema(oncFirewallDefaultsSchema),
      zone: oncSectionSchema(oncFirewallZoneSchema),
      forwarding: oncSectionSchema(oncFirewallForwardingSchema),
      rule: oncSectionSchema(oncFirewallRuleSchema),
      redirect: oncSectionSchema(oncFirewallRedirectSchema),
    })
    .passthrough()
).superRefine(knownTypes);

