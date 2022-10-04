import { z } from "zod";

export const firewallForwardingSchema = z
  .object({
    src: z.string(),
    dest: z.string(),
  })
  .strict();

export const oncFirewallForwardingSchema = firewallForwardingSchema;
