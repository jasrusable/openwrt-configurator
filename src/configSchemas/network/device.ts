import { z } from "zod";

export const networkDeviceSchema = z.object({
  name: z.string(),
  type: z.enum(["bridge"]),
  ports: z.array(z.string()),
});

export const oncNetworkDeviceSchema = networkDeviceSchema.extend({
  ports: z.union([z.enum(["*", "&*"]), z.array(z.string())]),
});
