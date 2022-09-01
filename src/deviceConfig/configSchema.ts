import { z } from "zod";

export const interfaceSchema = z.object({
  name: z.string(),
  device: z.string(),
  proto: z.enum(["dhcp", "static"]),
});

export const wifiSchema = z.object({
  ssid: z.string(),
});

export const deviceConfigSchema = z.object({
  target: z.object({
    deviceId: z.string(),
    openWrtVersion: z.string(),
  }),
  general: z.object({
    hostname: z.string(),
    timezone: z.string(),
  }),
  devices: z.array(
    z.object({
      name: z.string(),
      type: z.enum(["bridge"]),
      ports: z.array(z.string()),
    })
  ),
  interfaces: z.array(interfaceSchema),
});

export type DeviceConfig = z.infer<typeof deviceConfigSchema>;

export const deviceSchema = z.object({
  name: z.string(),
  ports: z
    .array(
      z.object({
        name: z.string(),
        role: z.enum(["lan", "wan", "cpu"]),
        cpuName: z.string().optional(),
      })
    )
    .optional(),
  flags: z.object({
    dsa: z.string(),
  }),
});

export type DeviceSchema = z.infer<typeof deviceSchema>;
