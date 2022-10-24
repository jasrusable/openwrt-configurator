import { z } from "zod";
import { allHtModes, wifiBands, wifiTypes } from "./openWrtValues";

export const deviceSchemaSchema = z.object({
  name: z.string(),
  sw_config: z.boolean().optional(),
  version: z.string(),
  config_sections: z.record(z.array(z.string())).optional(),
  ports: z
    .array(
      z.object({
        name: z.string(),
        default_role: z.enum(["lan", "wan"]).optional(),
        sw_config_cpu_name: z.string().optional(),
      })
    )
    .optional(),
  radios: z
    .array(
      z.object({
        name: z.string(),
        type: z.enum(wifiTypes),
        path: z.string(),
        band: z.enum(wifiBands),
        htmodes: z.array(z.enum(allHtModes)).optional(),
      })
    )
    .optional(),
});

export type DeviceSchema = z.infer<typeof deviceSchemaSchema>;
