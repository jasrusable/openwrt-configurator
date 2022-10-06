import { z } from "zod";

export const dhcpDhcpSchema = z
  .object({
    interface: z.string(),
    start: z.number(),
    limit: z.number(),
    dhcpv4: z.enum(["server"]).optional(),
    dhcpv6: z.enum(["server"]).optional(),
    ra: z.enum(["server"]).optional(),
    ra_flags: z.array(z.enum(["managed-config", "other-config"])).optional(),
    force: z.boolean().optional(),
    leasetime: z.string().optional(),
  })
  .passthrough();

export const oncDhcpDhcpSchema = dhcpDhcpSchema;
