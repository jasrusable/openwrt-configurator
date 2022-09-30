import { z } from "zod";

export const dhcpDnsmasqSchema = z.object({
  domainneeded: z.boolean(),
  localise_queries: z.boolean(),
  rebind_localhost: z.boolean(),
  local: z.string(),
  expandhosts: z.boolean(),
  authoritative: z.boolean(),
  readethers: z.boolean(),
  leasefile: z.string(),
  localservice: z.boolean(),
  ednspacket_max: z.number(),
  dnsforwardmax: z.number(),
  domain: z.string(),
  noresolv: z.boolean(),
  server: z.array(z.string()).optional(),
});

export const oncDhcpDnsmasqSchema = dhcpDnsmasqSchema;
