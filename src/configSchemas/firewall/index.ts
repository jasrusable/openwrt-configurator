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
  z.object({
    defaults: sectionSchema(firewallDefaultsSchema),
    zone: sectionSchema(firewallZoneSchema),
    forwarding: sectionSchema(firewallForwardingSchema),
    rule: sectionSchema(firewallRuleSchema),
  })
);

export const oncFirewallSchema = makeOncConfigSchema(
  z.object({
    defaults: oncSectionSchema(oncFirewallDefaultsSchema),
    zone: oncSectionSchema(oncFirewallZoneSchema),
    forwarding: oncSectionSchema(oncFirewallForwardingSchema),
    rule: oncSectionSchema(oncFirewallRuleSchema),
  })
);

export const firewallResetCommands = [
  "while uci -q delete firewall.@defaults[0]; do :; done",
  "while uci -q delete firewall.@zone[0]; do :; done",
  "while uci -q delete firewall.@forwarding[0]; do :; done",
  "while uci -q delete firewall.@rule[0]; do :; done",
];
