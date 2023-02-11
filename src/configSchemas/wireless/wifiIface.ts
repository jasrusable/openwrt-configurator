import { z } from "zod";

export const wirelessWifiIfaceSchema = z
  .object({
    device: z.string(),
    mode: z.enum(["ap", "mesh"]),
    network: z.string().optional(),
    ssid: z.string().optional(),
    encryption: z.string().optional(),
    key: z.string().optional(),
  })
  .passthrough();

export const oncWirelessWifiIfaceSchema = wirelessWifiIfaceSchema
  .extend({
    device: z.union([z.string(), z.enum(["*"]), z.array(z.string())]),
  })
  .passthrough();
