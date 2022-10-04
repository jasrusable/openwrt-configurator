import { z } from "zod";

export const networkBridgeVlanSchema = z
  .object({
    device: z.string(),
    vlan: z.number(),
    ports: z.array(z.string()),
  })
  .passthrough();

export const oncNetworkBridgeVlanSchema = networkBridgeVlanSchema
  .extend({
    ports: z.union([z.array(z.string()), z.enum(["*", "*t"])]),
  })
  .passthrough();
