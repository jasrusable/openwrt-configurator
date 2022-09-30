import { z, ZodObject, ZodRawShape, ZodSchema } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
} from "../../utils";
import { dhcpDnsmasqSchema, oncDhcpDnsmasqSchema } from "./dnsmasq";

export const dhcpSchema = configSchema(
  z.object({
    dnsmasq: sectionSchema(dhcpDnsmasqSchema),
  })
);

export const oncDhcpSchema = makeOncConfigSchema(
  z.object({
    dnsmasq: oncSectionSchema(oncDhcpDnsmasqSchema),
  })
);

export const dhcpResetCommands = [
  "while uci -q delete dhcp.@dnsmasq[0]; do :; done",
];
