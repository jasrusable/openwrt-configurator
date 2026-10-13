import { z } from "zod";

export const networkDeviceSchema = z.object({
  name: z.string(),
  // A bridge, or unset: settings for a device made elsewhere (the mesh's
  // interface, made by the Wi-Fi), applied by name when it appears.
  type: z.union([z.enum(["bridge"]), z.string()]).optional(),
  ports: z.array(z.string()).optional(),
  mtu: z.number().int().optional(),
  /** Off: no IPv6 on it at all, not even a link-local address. */
  ipv6: z.boolean().optional(),
});

export const oncNetworkDeviceSchema = networkDeviceSchema.extend({
  ports: z.union([z.literal("*"), z.array(z.string())]).optional(),
});
