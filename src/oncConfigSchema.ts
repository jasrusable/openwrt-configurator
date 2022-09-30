import { z } from "zod";
import {
  dhcpDnsmasqSchema,
  firewallDefaultSchema,
  firewallForwardingSchema,
  firewallRuleSchema,
  firewallZoneSchema,
  networkBridgeVlanSchema,
  networkDeviceSchema,
  networkInterfaceSchema,
  networkSwitchSchema,
  networkSwitchVlanSchema,
  systemSystemSchema,
  wirelessWifiIfaceSchema,
} from "./openWrtConfigSchema";

const extendedNetworkBridgeVlanSchema = networkBridgeVlanSchema.extend({
  ports: z.union([z.array(z.string()), z.enum(["*", "*t"])]),
});

const targetsSchema = z.union([
  z.enum(["*"]),
  z.array(
    z.object({
      opt: z.enum(["sw_config"]).optional(),
      tag: z.string().optional(),
      value: z.union([z.enum(["*"]), z.boolean(), z.array(z.string())]),
    })
  ),
]);

export type Targets = z.infer<typeof targetsSchema>;

const getExtensionSchema = (schema?: z.ZodObject<any>) => {
  const extensionSchema = z.object({
    targets: targetsSchema.optional(),
    target_overrides: z
      .array(
        z.object({
          targets: targetsSchema,
          overrides: schema ? schema.partial() : z.any(),
        })
      )
      .optional(),
  });

  return extensionSchema;
};

const temp = getExtensionSchema();

export type ExtensionSchema = z.infer<typeof temp>;

const extendedNetworkDeviceSchema = networkDeviceSchema.extend({
  ports: z.union([z.enum(["*", "&*"]), z.array(z.string())]),
});

const extendedNetworkSwitchVlanSchema = networkSwitchVlanSchema.extend({
  ports: z.union([z.enum(["*", "*t", "&*", "&*t"]), z.array(z.string())]),
});

const getTargetsExtension = (schema?: z.ZodObject<any>) => ({
  ".": getExtensionSchema(schema).optional(),
});

const networkSchema = z.object({
  switch: z
    .array(
      networkSwitchSchema
        .extend(getTargetsExtension(networkSwitchSchema))
        .strict()
    )
    .optional(),
  switch_vlan: z
    .array(
      extendedNetworkSwitchVlanSchema
        .partial()
        .extend(getTargetsExtension(extendedNetworkSwitchVlanSchema))
        .strict()
    )
    .optional(),
  device: z
    .array(
      extendedNetworkDeviceSchema
        .partial()
        .extend(getTargetsExtension(extendedNetworkDeviceSchema))
        .strict()
    )
    .optional(),
  "bridge-vlan": z
    .array(
      extendedNetworkBridgeVlanSchema
        .partial()
        .extend(getTargetsExtension(extendedNetworkBridgeVlanSchema))
        .strict()
    )
    .optional(),
  interface: z.array(
    networkInterfaceSchema
      .partial()
      .extend(getTargetsExtension(networkInterfaceSchema))
      .strict()
  ),
});

export const configConfigSchema = z.object({
  system: z
    .object({
      system: z.array(
        z
          .object({
            timezone: z.string(),
          })
          .strict()
          .extend(
            getTargetsExtension(systemSystemSchema.omit({ hostname: true }))
          )
      ),
    })
    .strict(),
  network: networkSchema.extend(getTargetsExtension(networkSchema)).strict(),
  firewall: z
    .object({
      defaults: z.array(
        firewallDefaultSchema
          .partial()
          .extend(getTargetsExtension(firewallDefaultSchema))
          .strict()
      ),
      zones: z.array(
        firewallZoneSchema
          .partial()
          .extend(getTargetsExtension(firewallZoneSchema))
          .strict()
      ),
      forwardings: z.array(
        firewallForwardingSchema
          .partial()
          .extend(getTargetsExtension(firewallForwardingSchema))
          .strict()
      ),
      rules: z.array(
        firewallRuleSchema
          .partial()
          .extend(getTargetsExtension(firewallRuleSchema))
          .strict()
      ),
    })
    .extend(getTargetsExtension()),
  dhcp: z
    .object({
      dnsmasq: z.array(
        dhcpDnsmasqSchema
          .partial()
          .extend(getTargetsExtension(dhcpDnsmasqSchema))
          .strict()
      ),
    })
    .partial()
    .extend(getTargetsExtension())
    .strict(),
  wireless: z
    .object({
      "wifi-iface": z.array(
        wirelessWifiIfaceSchema
          .partial()
          .extend(getTargetsExtension(wirelessWifiIfaceSchema))
          .omit({ device: true })
          .strict()
      ),
    })
    .partial()
    .extend(getTargetsExtension())
    .strict(),
});

export const oncConfigSchema = z
  .object({
    devices: z.array(
      z
        .object({
          enabled: z.boolean().optional(),
          model_id: z.string(),
          version: z.string(),
          ipaddr: z.string(),
          hostname: z.string(),
          tags: z.array(
            z.object({
              name: z.string(),
              value: z.array(z.string()),
            })
          ),
          provisioning_config: z
            .object({
              ssh_auth: z.object({
                username: z.string(),
                password: z.string(),
              }),
            })
            .optional(),
        })
        .strict()
    ),
    config: configConfigSchema,
  })
  .strict();

export type ONCConfig = z.infer<typeof oncConfigSchema>;

export type ONCDeviceConfig = ONCConfig["devices"][0];
