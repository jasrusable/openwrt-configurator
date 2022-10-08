import { z } from "zod";

export const wirelessWifiIfaceSchema = z
  .object({
    device: z.string(),
    mode: z.enum(["ap"]),
    network: z.string(),
    ssid: z.string().optional(),
    encryption: z.string().optional(),
    key: z.string().optional(),
  })
  .passthrough();

export const oncWirelessWifiIfaceSchema = wirelessWifiIfaceSchema
  .omit({ device: true })
  .passthrough();
