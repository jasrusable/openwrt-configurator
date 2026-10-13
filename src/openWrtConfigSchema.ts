import { z } from "zod";
import { dhcpSchema } from "./configSchemas/dhcp";
import { firewallSchema } from "./configSchemas/firewall";
import { networkSchema } from "./configSchemas/network";
import { systemSchema } from "./configSchemas/system";
import { wirelessSchema } from "./configSchemas/wireless";

export const openWrtConfigSchema = z
  .object({
    system: systemSchema,
    network: networkSchema,
    firewall: firewallSchema,
    dhcp: dhcpSchema,
    wireless: wirelessSchema,
  })
  .catchall(z.record(z.array(z.record(z.any()))));

export type OpenWrtConfig = z.infer<typeof openWrtConfigSchema>;

export type OpenWrtState = {
  config: OpenWrtConfig;
  packagesToInstall?: { packageName: string }[];
  packagesToUninstall?: string[];
  /**
   * `configs_to_not_reset` for this device: `<config>.*` or
   * `<config>.<section type>`. Everything else on the device is wiped.
   */
  configsToNotReset?: string[];
  /** Services to keep enabled and started; `running` ones are checked. */
  services?: { name: string; running: boolean; enabled?: boolean; restart_after_rollback?: boolean }[];
  files?: {
    path: string;
    content: string;
    mode?: string;
    /** Runs as soon as the file is written — before `uci commit`. */
    run_after?: string;
    /** Runs after `uci commit` and `reload_config`, so the config is live. */
    run_after_reload?: string;
  }[];
};
