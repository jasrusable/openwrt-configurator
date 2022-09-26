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
      z
        .object({
          enabled: z.boolean().optional(),
          device_model_id: z.string(),
          version: z.string(),
          roles: z.array(z.enum(["router", "ap"])),
          ipaddr: z.string().optional(),
          provisioning_config: z
            .object({
              ssh_auth: z.object({
                username: z.string(),
                password: z.string(),
              }),
            })
            .optional(),
          system: z.object({
            hostname: z.string(),
          }),
        })
        .strict()
    ),
    config: z
      .object({
        system: z
          .object({
            timezone: z.string(),
          })
          .strict(),
        firewall: z
          .object({
            defaults: firewallDefaultSchema.strict(),
            zones: z.array(firewallZoneSchema.strict()),
            forwardings: z.array(firewallForwardingSchema.strict()),
            rules: z.array(firewallRuleSchema.strict()),
          })
          .strict(),
        dhcp: z.object({
          dnsmasq: dhcpDnsmasqSchema.strict(),
        }),
        network: z
          .object({
            networks: z.array(
              z
                .object({
                  name: z.string(),
                  router: z
                    .object({
                      device: z.string().optional(),
                      proto: z.enum(["static", "dhcp", "pppoe"]),
                      ipaddr: z.string().optional(),
                      netmask: z.string().optional(),
                    })
                    .strict()
                    .optional(),
                  non_router: z
                    .object({
                      proto: z.enum(["dhcp"]),
                    })
                    .strict()
                    .optional(),
                  vlan: z.number().optional(),
                  vlan_untagged: z.boolean().optional(),
                })
                .strict()
            ),
          })
          .strict(),
        wireless: z
          .object({
            "wifi-iface": z.array(
              wirelessWifiIfaceSchema.omit({ device: true }).strict()
            ),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export type ONCConfig = z.infer<typeof oncConfigSchema>;

export type ONCDeviceConfig = ONCConfig["devices"][0];
