import { z } from "zod";
import { nameValidation } from "../../utils";

export const networkInterfaceSchema = z
  .object({
    ".name": nameValidation,
    device: z.string(),
    proto: z.enum(["static", "dhcp", "pppoe"]),
    ipaddr: z.string().optional(),
    netmask: z.string().optional(),
  })
  .passthrough();

export const oncNetworkInterfaceSchema = networkInterfaceSchema.extend({
  name: nameValidation.optional(),
});
