import { z } from "zod";
import { firewallTargets } from "../../openWrtValues";

export const firewallDefaultsSchema = z
  .object({
    input: z.enum(firewallTargets),
    output: z.enum(firewallTargets),
    forward: z.enum(firewallTargets),
    synflood_protect: z.boolean().optional(),
  })
  .passthrough();

export const oncFirewallDefaultsSchema = firewallDefaultsSchema;
