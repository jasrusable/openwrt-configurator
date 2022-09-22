import { z } from "zod";

export const deviceSchema = z.object({
  name: z.string(),
  flags: z.object({
    swConfig: z.string(),
  }),
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
        band: z.enum(["2g", "5g"]),
        htmodes: z.array(z.enum(["HT20", "VHT80"])),
      })
    )
    .optional(),
});

export type DeviceSchema = z.infer<typeof deviceSchema>;
