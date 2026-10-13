import { z } from "zod";
import { oncWirelessWifiStationSchema, wifiPskSchema } from "./wifiStation";

export const wirelessWifiIfaceSchema = z
  .object({
    device: z.string(),
    mode: z.enum(["ap", "mesh"]),
    network: z.string().optional(),
    ssid: z.string().optional(),
    encryption: z.string().optional(),
    key: wifiPskSchema.optional(),
    /** Its own device name (the mesh's mesh0): one interface, so on one radio only. */
    ifname: z.string().optional(),
  })
  .passthrough();

export const oncWirelessWifiIfaceSchema = wirelessWifiIfaceSchema
  .extend({
    device: z.union([z.string(), z.enum(["*"]), z.array(z.string())]),
    stations: z.array(oncWirelessWifiStationSchema).optional(),
  })
  .passthrough();
