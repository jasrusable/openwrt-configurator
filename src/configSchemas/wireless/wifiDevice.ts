import { z } from "zod";
import { allHtModes, wifiBands, wifiTypes } from "../../openWrtValues";

export const wirelessWifiDeviceSchema = z
  .object({
    type: z.enum(wifiTypes),
    // How OpenWrt finds the radio: by path, or by phy name; `radio` picks
    // one of several a wiphy has.
    path: z.string().optional(),
    phy: z.string().optional(),
    radio: z.number().optional(),
    band: z.enum(wifiBands),
    channel: z.union([z.enum(["auto"]), z.number()]).optional(),
    htmode: z.enum(allHtModes).optional(),
  })
  .passthrough();

export const oncWirelessWifiDeviceSchema = wirelessWifiDeviceSchema
  .omit({ type: true, path: true, phy: true, radio: true })
  .extend({
    // Or the best mode the radio supports up to a width, resolved per device
    // (src/radioModes.ts).
    htmode: z.union([z.enum(allHtModes), z.string().regex(/^@best\/\d+$/)]).optional(),
  });
