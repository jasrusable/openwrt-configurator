import { z } from "zod";

export const deviceConfigSchema = z.object({
  target: z.object({
    deviceId: z.string(),
    openWrtVersion: z.string(),
  }),
  system: z.object({
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
  interfaces: z.array(
    z.object({
      // General settings
      name: z.string(),
      device: z.string(),
      bringUpAtBoot: z.boolean().optional(),
      forceLink: z.boolean().optional(),
      useDefaultGateway: z.boolean().optional(),
      proto: z.enum(["dhcp", "static"]),

      // Static settings
      // ipv4
      ipv4Address: z.string().optional(),
      ipv4NetMask: z.string().optional(),
      ipv4Gateway: z.string().optional(),
      ipv4Broadcast: z.string().optional(),
      // ipv6
      ipv6Addresses: z.array(z.string()).optional(),
      ipv6Gateway: z.string().optional(),
      ipv6Prefix: z.string().optional(),
    })
  ),
  wireless: z.object({
    radios: z.array(
      z.object({
        name: z.string(),
        channel: z.number(),
        disabled: z.boolean().optional(),
        cellDensity: z
          .enum(["disabled", "normal", "high", "veryHigh"])
          .optional(),
      })
    ),
    networks: z.array(
      z.object({
        device: z.string(),
        mode: z.enum(["ap"]),
        ssid: z.string().optional(),
        encryption: z
          .enum(["sae", "sae-mixed", "psk2", "psk-mixed", "psk", "none", "owe"])
          .optional(),
        key: z.string().optional(),
        network: z.string().optional(),
        wmm: z.boolean().optional(),
      })
    ),
  }),
});

export type DeviceConfig = z.infer<typeof deviceConfigSchema>;

export const deviceSchema = z.object({
  name: z.string(),
  flags: z.object({
    dsa: z.string(),
  }),
  ports: z
    .array(
      z.object({
        name: z.string(),
        role: z.enum(["lan", "wan", "cpu"]),
        cpuName: z.string().optional(),
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
        htmode: z.enum(["HT20", "VHT80"]),
      })
    )
    .optional(),
});

export type DeviceSchema = z.infer<typeof deviceSchema>;
