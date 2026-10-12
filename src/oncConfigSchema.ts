import { z } from "zod";
import { oncDhcpSchema } from "./configSchemas/dhcp";
import { oncFirewallSchema } from "./configSchemas/firewall";
import { oncNetworkSchema } from "./configSchemas/network";
import { oncSystemSchema } from "./configSchemas/system";
import { oncWirelessSchema } from "./configSchemas/wireless";
import { conditionSchema } from "./utils";

export const configConfigSchema = z
  .object({
    system: oncSystemSchema.optional(),
    network: oncNetworkSchema.optional(),
    firewall: oncFirewallSchema.optional(),
    dhcp: oncDhcpSchema.optional(),
    wireless: oncWirelessSchema.optional(),
  })
  .passthrough();

export const versionSchema = z.union([
  z.string(),
  z
    .object({
      ".value": z.string(),
      ".overrides": z
        .array(
          z
            .object({
              ".if": conditionSchema,
              override: z.object({ ".value": z.string() }).strict(),
            })
            .strict()
        )
        .optional(),
    })
    .strict(),
]);

export const oncConfigSchema = z
  .object({
    version: versionSchema.optional(),
    devices: z.array(
      z
        .object({
          enabled: z.boolean().optional(),
          // Optional: read from the device's board.json when absent. Set,
          // it is checked against the device, and build-images needs it.
          model_id: z.string().optional(),
          /** Only needed to provision or inspect the device over SSH. */
          ipaddr: z.string().optional(),
          hostname: z.string(),
          tags: z.record(z.union([z.string(), z.array(z.string())])),
          provisioning_config: z
            .object({
              ssh_auth: z.object({
                username: z.string(),
                password: z.string().optional(),
                private_key_path: z.string().optional(),
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
            ".if": conditionSchema.optional(),
            // apk's own name charset; a leading "-" means remove.
            packages: z.array(
              z
                .string()
                .regex(
                  /^-?[A-Za-z0-9][A-Za-z0-9._+-]*$/,
                  "must be an apk package name, optionally prefixed with - to remove it"
                )
            ),
          })
          .strict()
      )
      .optional(),
    /**
     * Services the device must have enabled at boot and started (procd then
     * reloads them on their config's changes; a stopped one would ignore
     * them). `running`: it must also have a running process afterwards,
     * which is checked. An init script the device lacks is skipped.
     */
    services: z
      .array(
        z
          .object({
            ".if": conditionSchema.optional(),
            name: z.string().regex(/^[A-Za-z0-9_-]+$/, "must be an init script name"),
            running: z.boolean().optional(),
          })
          .strict()
      )
      .optional(),
    files: z
      .array(
        z
          .object({
            ".if": conditionSchema.optional(),
            path: z.string().startsWith("/", "must be an absolute path"),
            content: z.string(),
            mode: z
              .string()
              .regex(/^[0-7]{3,4}$/, "must be an octal mode such as 0755")
              .optional(),
            run_after: z.string().optional(),
            run_after_reload: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    configs_to_not_reset: z
      .array(
        z
          .object({
            ".if": conditionSchema.optional(),
            configs: z.array(z.string()),
          })
          .strict()
      )
      .optional(),
    config: configConfigSchema,
  })
  .strict();

export type ONCConfig = z.infer<typeof oncConfigSchema>;

export type ONCDeviceConfig = ONCConfig["devices"][0];
