import { z } from "zod";
import { allHtModes, wifiBands, wifiTypes } from "../../openWrtValues";

export const wirelessWifiDeviceSchema = z
  .object({
    type: z.enum(wifiTypes),
    path: z.string(),
    band: z.enum(wifiBands),
    channel: z.union([z.enum(["auto"]), z.number()]).optional(),
    htmode: z.enum(allHtModes).optional(),
  })
  .passthrough();

export const oncWirelessWifiDeviceSchema = wirelessWifiDeviceSchema.omit({
  type: true,
  path: true,
});
