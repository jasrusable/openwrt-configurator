import { z } from "zod";
import { dhcpSchema } from "./configSchemas/dhcp";
import { firewallSchema } from "./configSchemas/firewall";
import { networkSchema } from "./configSchemas/network";
import { systemSchema } from "./configSchemas/system";
import { wirelessSchema } from "./configSchemas/wireless";

const schemaSchema = z.array(
  z.object({
    config: z.enum(["system", "network"]),
    sections: z.array(
      z.object({
        type: z.enum(["system", "device", "interface"]),
        properties: z.array(
          z.object({
            type: z.enum(["option", "collection"]),
            name: z.string(),
          })
        ),
      })
    ),
  })
);

type SchemaSchema = z.infer<typeof schemaSchema>;

const schema: SchemaSchema = [
  {
    config: "system",
    sections: [
      {
        type: "system",
        properties: [
          {
            type: "option",
            name: "hostname",
          },
          {
            type: "option",
            name: "timezone",
          },
        ],
      },
    ],
  },
  {
    config: "network",
    sections: [
      {
        type: "device",
        properties: [
          { type: "option", name: "name" },
          { type: "option", name: "type" },
          { type: "collection", name: "ports" },
        ],
      },
      {
        type: "interface",
        properties: [
          { type: "option", name: "device" },
          { type: "option", name: "proto" },
          { type: "option", name: "ipaddr" },
          { type: "option", name: "netmask" },
        ],
      },
    ],
  },
];

export const openWrtConfigSchema = z.object({
  system: systemSchema,
  network: networkSchema,
  firewall: firewallSchema,
  dhcp: dhcpSchema,
  wireless: wirelessSchema,
});

export type OpenWrtConfig = z.infer<typeof openWrtConfigSchema>;

export type OpenWrtState = {
  config: OpenWrtConfig;
  packagesToInstall?: { packageName: string; version?: string }[];
  packagesToUninstall?: string[];
};
