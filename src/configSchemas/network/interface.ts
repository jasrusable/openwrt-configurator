import { z } from "zod";

export const networkInterfaceSchema = z.object({
  name: z.string(),
  device: z.string(),
  proto: z.enum(["static", "dhcp", "pppoe"]),
  ipaddr: z.string().optional(),
  netmask: z.string().optional(),
});

export const oncNetworkInterfaceSchema = networkInterfaceSchema;
