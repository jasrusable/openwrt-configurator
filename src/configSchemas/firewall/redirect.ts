import { z } from "zod";
import { firewallProtocols } from "../../openWrtValues";

// A NAT rule: here a port forward (DNAT) from the WAN to a host inside.
export const firewallRedirectSchema = z
  .object({
    name: z.string(),
    enabled: z.boolean().optional(),
    target: z.enum(["DNAT", "SNAT"]),
    src: z.string(),
    src_ip: z.array(z.string()).optional(),
    src_dport: z.string().optional(),
    proto: z.array(z.enum(firewallProtocols)).optional(),
    dest: z.string().optional(),
    dest_ip: z.string().optional(),
    dest_port: z.string().optional(),
    family: z.enum(["any", "ipv4", "ipv6"]).optional(),
    reflection: z.boolean().optional(),
  })
  .strict();

export const oncFirewallRedirectSchema = firewallRedirectSchema;
