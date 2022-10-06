import { z, ZodObject, ZodRawShape, ZodSchema } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
} from "../../utils";
import { dhcpDhcpSchema, oncDhcpDhcpSchema } from "./dhcp";
import { dhcpDnsmasqSchema, oncDhcpDnsmasqSchema } from "./dnsmasq";
import { dhcpOdhcpdSchema, oncDhcpOdhcpdSchema } from "./odhcpd";

export const dhcpSchema = configSchema(
  z
    .object({
      dnsmasq: sectionSchema(dhcpDnsmasqSchema),
      dhcp: sectionSchema(dhcpDhcpSchema),
      odhcpd: sectionSchema(dhcpOdhcpdSchema),
    })
    .passthrough()
);

export const oncDhcpSchema = makeOncConfigSchema(
  z
    .object({
      dnsmasq: oncSectionSchema(oncDhcpDnsmasqSchema),
      dhcp: oncSectionSchema(oncDhcpDhcpSchema),
      odhcpd: oncSectionSchema(oncDhcpOdhcpdSchema),
    })
    .passthrough()
);

export const dhcpResetCommands = [
  "while uci -q delete dhcp.@dnsmasq[0]; do :; done",
  "while uci -q delete dhcp.@dhcp[0]; do :; done",
  "while uci -q delete dhcp.@odhcpd[0]; do :; done",
];
