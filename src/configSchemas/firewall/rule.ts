import { z } from "zod";
import {
  firewallProtocols,
  firewallTargets,
  icmpTypes,
} from "../../openWrtValues";

export const firewallRuleSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string(),
  proto: z.array(z.enum(firewallProtocols)).optional(),
  icmp_type: z.array(z.enum(icmpTypes)).optional(),
  src: z.string().optional(),
  src_ip: z.array(z.string()).optional(),
  dest: z.string().optional(),
  dest_port: z.union([z.string(), z.array(z.number())]).optional(),
  dest_ip: z.array(z.string()).optional(),
  family: z.enum(["any", "ipv4", "ipv6"]).optional(),
  target: z.enum(firewallTargets),
  limit: z.string().optional(),
});

export const oncFirewallRuleSchema = firewallRuleSchema;
