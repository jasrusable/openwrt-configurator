import { z } from "zod";
import {
  dhcpDnsmasqSchema,
  firewallDefaultSchema,
  firewallForwardingSchema,
  firewallRuleSchema,
  firewallZoneSchema,
  wirelessWifiIfaceSchema,
} from "./openWRTConfigSchema";

export const oncConfigSchema = z
  .object({
    devices: z.array(
      z.object({
        deviceId: z.string(),
        version: z.string(),
        roles: z.array(z.enum(["router", "ap"])),
        system: z.object({
          hostname: z.string(),
        }),
      })
    ),
    system: z.object({
      timezone: z.string(),
    }),
    firewall: z.object({
      defaults: firewallDefaultSchema,
      zones: z.array(firewallZoneSchema),
      forwardings: z.array(firewallForwardingSchema),
      rules: z.array(firewallRuleSchema),
    }),
    network: z.object({
      networks: z.array(
        z.object({
          name: z.string(),
          router: z
            .object({
              device: z.string().optional(),
              proto: z.enum(["static", "dhcp", "pppoe"]),
              ipaddr: z.string().optional(),
              netmask: z.string().optional(),
            })
            .optional(),
          devices: z
            .object({
              proto: z.enum(["dhcp"]),
            })
            .optional(),
          vlan: z.number().optional(),
          vlan_untagged: z.boolean().optional(),
        })
      ),
    }),
    wireless: z.object({
      "wifi-iface": z.array(wirelessWifiIfaceSchema.omit({ device: true })),
    }),
    dhcp: z.object({ dnsmasq: dhcpDnsmasqSchema }),
  })
  .strict();

export type ONCConfig = z.infer<typeof oncConfigSchema>;

export type ONCDeviceConfig = ONCConfig["devices"][0];
