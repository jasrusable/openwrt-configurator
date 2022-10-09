import { z } from "zod";
import { oncDhcpSchema } from "./configSchemas/dhcp";
import { oncFirewallSchema } from "./configSchemas/firewall";
import { oncNetworkSchema } from "./configSchemas/network";
import { oncSystemSchema } from "./configSchemas/system";
import { oncWirelessSchema } from "./configSchemas/wireless";
import { targetSchema } from "./utils";

export const configConfigSchema = z.object({
  system: oncSystemSchema.optional(),
  network: oncNetworkSchema.optional(),
  firewall: oncFirewallSchema.optional(),
  dhcp: oncDhcpSchema.optional(),
  wireless: oncWirelessSchema.optional(),
});

export const oncConfigSchema = z
  .object({
    devices: z.array(
      z
        .object({
          enabled: z.boolean().optional(),
          model_id: z.string(),
          ipaddr: z.string(),
          hostname: z.string(),
          tags: z.record(z.union([z.string(), z.array(z.string())])),
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
    package_profiles: z
      .array(
        z
          .object({
            target: targetSchema,
            packages: z.array(z.string()),
          })
          .strict()
      )
      .optional(),
    config: configConfigSchema,
  })
  .strict();

export type ONCConfig = z.infer<typeof oncConfigSchema>;

export type ONCDeviceConfig = ONCConfig["devices"][0];
