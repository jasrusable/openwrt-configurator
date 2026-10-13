import { z } from "zod";
import { nameValidation } from "../../utils";

export const networkInterfaceSchema = z
  .object({
    ".name": nameValidation,
    device: z.string().optional(),
    // "none": an interface with no address, e.g. a VLAN an access point only bridges.
    proto: z.enum(["static", "dhcp", "dhcpv6", "pppoe", "batadv", "batadv_hardif", "wireguard", "none"]),
    ipaddr: z.string().optional(),
    netmask: z.string().optional(),
  })
  .passthrough();

export const oncNetworkInterfaceSchema = networkInterfaceSchema;
