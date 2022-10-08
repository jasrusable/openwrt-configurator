import { z } from "zod";
import { wifiBands } from "../../openWrtValues";

export const wirelessWifiIfaceSchema = z
  .object({
    device: z.string(),
    mode: z.enum(["ap"]),
    network: z.string().optional(),
    ssid: z.string().optional(),
    encryption: z.string().optional(),
    key: z.string().optional(),
  })
  .passthrough();

export const oncWirelessWifiIfaceSchema = wirelessWifiIfaceSchema
  .omit({ device: true })
  .extend({
    band: z.union([
      z.enum(wifiBands),
      z.enum(["all"]),
      z.array(z.enum(wifiBands)),
    ]),
  })
  .passthrough();
