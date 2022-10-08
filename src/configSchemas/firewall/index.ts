import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
} from "../../utils";
import { firewallDefaultsSchema, oncFirewallDefaultsSchema } from "./default";
import {
  firewallForwardingSchema,
  oncFirewallForwardingSchema,
} from "./forwarding";
import { firewallRuleSchema, oncFirewallRuleSchema } from "./rule";
import { firewallZoneSchema, oncFirewallZoneSchema } from "./zone";

export const firewallSchema = configSchema(
  z
    .object({
      defaults: sectionSchema(firewallDefaultsSchema),
      zone: sectionSchema(firewallZoneSchema),
      forwarding: sectionSchema(firewallForwardingSchema),
      rule: sectionSchema(firewallRuleSchema),
    })
    .passthrough()
);

export const oncFirewallSchema = makeOncConfigSchema(
  z
    .object({
      defaults: oncSectionSchema(oncFirewallDefaultsSchema),
      zone: oncSectionSchema(oncFirewallZoneSchema),
      forwarding: oncSectionSchema(oncFirewallForwardingSchema),
      rule: oncSectionSchema(oncFirewallRuleSchema),
    })
    .passthrough()
);

export const firewallSectionsToReset = {
  firewall: {
    defaults: true,
    zone: true,
    forwarding: true,
    rule: true,
  },
};
