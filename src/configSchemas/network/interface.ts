import { z } from "zod";

export const networkInterfaceSchema = z
  .object({
    device: z.string(),
    proto: z.enum(["static", "dhcp", "pppoe"]),
    ipaddr: z.string().optional(),
    netmask: z.string().optional(),
  })
  .passthrough();

export const oncNetworkInterfaceSchema = networkInterfaceSchema;
