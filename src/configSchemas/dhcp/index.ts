import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
  onlySectionTypes,
} from "../../utils";
import { dhcpDhcpSchema, oncDhcpDhcpSchema } from "./dhcp";
import { dhcpDnsmasqSchema, oncDhcpDnsmasqSchema } from "./dnsmasq";
import { dhcpOdhcpdSchema, oncDhcpOdhcpdSchema } from "./odhcpd";

// OpenWrt's dhcp section types.
const knownTypes = onlySectionTypes(["dnsmasq", "dhcp", "odhcpd", "host", "domain", "boot", "mac", "tag", "vendorclass", "userclass", "match", "subscrid", "relay", "cname", "hostrecord", "srvhost", "mxhost", "ipset"]);

export const dhcpSchema = configSchema(
  z
    .object({
      dnsmasq: sectionSchema(dhcpDnsmasqSchema),
      dhcp: sectionSchema(dhcpDhcpSchema),
      odhcpd: sectionSchema(dhcpOdhcpdSchema),
    })
    .passthrough()
).superRefine(knownTypes);

export const oncDhcpSchema = makeOncConfigSchema(
  z
    .object({
      dnsmasq: oncSectionSchema(oncDhcpDnsmasqSchema),
      dhcp: oncSectionSchema(oncDhcpDhcpSchema),
      odhcpd: oncSectionSchema(oncDhcpOdhcpdSchema),
    })
    .passthrough()
).superRefine(knownTypes);

