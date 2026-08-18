import { z } from "zod";

/** WPA-PSK passphrase (8–63) or raw 256-bit PSK (64 hex digits). */
export const wifiPskSchema = z
  .string()
  .refine(
    (key) =>
      (key.length >= 8 && key.length <= 63) || /^[0-9a-fA-F]{64}$/.test(key),
    { message: "WPA PSK must be 8-63 characters or 64 hex digits" }
  );

export const wirelessWifiStationSchema = z
  .object({
    iface: z.string(),
    key: wifiPskSchema,
    mac: z.string().optional(),
  })
  .passthrough();

export const oncWirelessWifiStationSchema = z
  .object({
    key: wifiPskSchema,
  })
  .passthrough();
