import { z } from "zod";
import { firewallTargets } from "../../openWrtValues";

export const firewallZoneSchema = z
  .object({
    name: z.string(),
    input: z.enum(firewallTargets),
    output: z.enum(firewallTargets),
    forward: z.enum(firewallTargets),
    masq: z.boolean().optional(),
    mtu_fix: z.boolean().optional(),
    network: z.array(z.string()),
  })
  .passthrough();

export const oncFirewallZoneSchema = firewallZoneSchema;
