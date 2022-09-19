#!/usr/bin/env node

import fs from "fs";
import commandLineArgs from "command-line-args";
import commandLineUsage from "command-line-usage";
import { getDeviceScript } from "./openwrt-backend";
import { z } from "zod";
import { deviceSchema } from "./deviceConfig/configSchema";

export enum Roles {
  AP = "ap",
  Router = "router",
}

export enum WifiEncryption {
  Psk2 = "psk2",
  None = "none",
}

const configSchema = z
  .object({
    general: z
      .object({
        timezone: z.string(),
      })
      .strict(),
    networks: z.array(
      z.object({
        name: z.string(),
        router: z
          .object({
            protocol: z.enum(["static", "dhcp", "pppoe"]),
            ip: z.string().optional(),
            netmask: z.string().optional(),
            firewallZone: z.string(),
          })
          .optional(),
        devices: z
          .object({
            protocol: z.enum(["dhcp"]),
          })
          .optional(),
        vlan: z.number().optional(),
        vlanUntagged: z.boolean().optional(),
      })
    ),
    wifi: z.array(
      z.object({
        mode: z.enum(["ap"]),
        ssid: z.string(),
        encryption: z.nativeEnum(WifiEncryption),
        key: z.string().optional(),
        network: z.string(),
      })
    ),
    devices: z.array(
      z.object({
        deviceId: z.string(),
        version: z.string(),
        roles: z.array(z.nativeEnum(Roles)),
        hostname: z.string(),
      })
    ),
  })
  .strict();
export type Config = z.infer<typeof configSchema>;
export type DeviceConfig = Config["devices"][0];

const optionDefinitions = [
  {
    name: "config",
    type: String,
    description: "Path to a config file.",
  },
  { name: "help", description: "Print this usage guide." },
];

export const main = () => {
  const options = commandLineArgs(optionDefinitions);

  if (options.help !== undefined) {
    const sections = [
      {
        header: "ONC",
        content: "Open Network Controller",
      },
      {
        header: "Options",
        optionList: optionDefinitions,
      },
    ];
    const usage = commandLineUsage(sections);
    console.log(usage);
  } else {
    console.log(options);
    const configString = fs.readFileSync(options.config, "utf-8");
    const config: Config = configSchema.parse(JSON.parse(configString));
    config.devices.forEach((deviceConfig) => {
      const device = deviceSchema.parse(
        JSON.parse(
          fs.readFileSync(
            `./deviceSchemas/${deviceConfig.deviceId}.json`,
            "utf-8"
          )
        )
      );
      const a = getDeviceScript({
        config,
        deviceConfig: deviceConfig,
        deviceSchema: device,
      });
      console.log(`#device ${deviceConfig.hostname}`);
      console.log(a.join("\n"));
    });
  }
};

main();
