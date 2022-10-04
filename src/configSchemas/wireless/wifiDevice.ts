import { z } from "zod";

export const wirelessWifiDeviceSchema = z
  .object({
    type: z.string(),
    path: z.string(),
    channel: z.number(),
    band: z.string(),
    htmode: z.string(),
  })
  .passthrough();

export const oncWirelessWifiDeviceSchema = wirelessWifiDeviceSchema;
