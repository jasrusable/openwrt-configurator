import { z } from "zod";

export const dhcpDnsmasqSchema = z
  .object({
    domainneeded: z.boolean().optional(),
    localise_queries: z.boolean().optional(),
    rebind_localhost: z.boolean().optional(),
    local: z.string().optional(),
    expandhosts: z.boolean(),
    authoritative: z.boolean().optional(),
    bogusnxdomain: z.array(z.string()).optional(),
    boguspriv: z.boolean().optional(),
    cachelocal: z.boolean().optional(),
    cachesize: z.number().optional(),
    dbus: z.boolean().optional(),
    readethers: z.boolean().optional(),
    leasefile: z.string().optional(),
    localservice: z.boolean().optional(),
    ednspacket_max: z.number().optional(),
    dnsforwardmax: z.number().optional(),
    domain: z.string().optional(),
    noresolv: z.boolean().optional(),
    server: z.array(z.string()).optional(),
    add_local_domain: z.boolean().optional(),
    add_local_hostname: z.boolean().optional(),
    add_local_fqdn: z.number().min(0).max(4).optional(),
    add_wan_fqdn: z.number().optional(),
    addnhosts: z.array(z.string()).optional(),
  })
  .passthrough();

export const oncDhcpDnsmasqSchema = dhcpDnsmasqSchema;
