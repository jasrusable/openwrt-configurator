import { z } from "zod";

export const deviceSchemaSchema = z.object({
  name: z.string(),
  swConfig: z.boolean().optional(),
  ports: z
    .array(
      z.object({
        name: z.string(),
        defaultRole: z.enum(["lan", "wan"]).optional(),
        swConfigCpuName: z.string().optional(),
      })
    )
    .optional(),
  radios: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(["mac80211"]),
        path: z.string(),
        band: z.enum(["2g", "5g", "6g"]),
        htmodes: z.array(
          z.enum(["HT20", "HT40", "VHT20", "VHT40", "VHT80", "VHT160"])
        ),
      })
    )
    .optional(),
});

export type DeviceSchema = z.infer<typeof deviceSchemaSchema>;
