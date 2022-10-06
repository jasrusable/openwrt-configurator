import { z } from "zod";

export const dhcpOdhcpdSchema = z
  .object({
    maindhcp: z.boolean().optional(),
    leasefile: z.string().optional(),
    leasetrigger: z.string().optional(),
    loglevel: z.number().optional(),
  })
  .passthrough();

export const oncDhcpOdhcpdSchema = dhcpOdhcpdSchema;
