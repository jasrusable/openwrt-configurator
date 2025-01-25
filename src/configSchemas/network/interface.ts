import { z } from "zod";
import { nameValidation } from "../../utils";

export const networkInterfaceSchema = z
  .object({
    ".name": nameValidation,
    device: z.string().optional(),
    proto: z.enum(["static", "dhcp", "dhcpv6", "pppoe", "batadv", "batadv_hardif"]),
    ipaddr: z.string().optional(),
    netmask: z.string().optional(),
  })
  .passthrough();

export const oncNetworkInterfaceSchema = networkInterfaceSchema.extend({
  name: nameValidation.optional(),
});
