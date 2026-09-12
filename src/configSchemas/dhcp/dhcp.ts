import { z } from "zod";

export const dhcpDhcpSchema = z
  .object({
    interface: z.string().optional(),
    start: z.number().optional(),
    limit: z.number().optional(),
    dhcpv4: z.enum(["server", "disabled"]).optional(),
    dhcpv6: z.enum(["server", "hybrid", "disabled"]).optional(),
    ra: z.enum(["server", "hybrid", "disabled"]).optional(),
    ra_flags: z.array(z.enum(["managed-config", "other-config"])).optional(),
    force: z.boolean().optional(),
    leasetime: z.string().optional(),
  })
  .passthrough();

export const oncDhcpDhcpSchema = dhcpDhcpSchema;
