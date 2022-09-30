import { z } from "zod";
import { oncDhcpSchema } from "./configSchemas/dhcp";
import { oncFirewallSchema } from "./configSchemas/firewall";
import { oncNetworkSchema } from "./configSchemas/network";
import { oncSystemSchema } from "./configSchemas/system";
import { oncWirelessSchema } from "./configSchemas/wireless";

export const configConfigSchema = z.object({
  system: oncSystemSchema,
  network: oncNetworkSchema,
  firewall: oncFirewallSchema,
  dhcp: oncDhcpSchema,
  wireless: oncWirelessSchema,
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
