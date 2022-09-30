import { z } from "zod";

export const wirelessWifiIfaceSchema = z.object({
  device: z.string(),
  mode: z.enum(["ap"]),
  network: z.string(),
  ssid: z.string(),
  encryption: z.string(),
  key: z.string(),
});

export const oncWirelessWifiIfaceSchema = wirelessWifiIfaceSchema.omit({
  device: true,
});
