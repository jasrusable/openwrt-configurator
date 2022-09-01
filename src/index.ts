import fs from "fs";
import commandLineArgs from "command-line-args";
import commandLineUsage from "command-line-usage";
import { getDeviceScript } from "./openwrt-backend";
import { z } from "zod";

enum Roles {
  AP = "ap",
  Router = "router",
}

const ZodDevice = z
  .object({
    deviceId: z.string(),
    roles: z.array(z.nativeEnum(Roles)),
    hostname: z.string(),
  })
  .strict();
export type Device = z.infer<typeof ZodDevice>;

const ZodNetwork = z
  .object({
    name: z.string(),
    ip: z.string(),
  })
  .strict();
export type Network = z.infer<typeof ZodNetwork>;

enum WifiMode {
  Ap = "ap",
}

enum WifiEncryption {
  Psk2 = "psk2",
}

const ZodWifi = z
  .object({
    mode: z.nativeEnum(WifiMode),
    device: z.string(),
    ssid: z.string(),
    encryption: z.nativeEnum(WifiEncryption),
    key: z.string(),
    network: z.string(),
  })
  .strict();
export type Wifi = z.infer<typeof ZodWifi>;

const ZodConfig = z
  .object({
    general: z
      .object({
        timezone: z.string(),
      })
      .strict(),
    networks: z.array(ZodNetwork),
    wifi: z.array(ZodWifi),
    devices: z.array(ZodDevice),
  })
  .strict();
export type Config = z.infer<typeof ZodConfig>;

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
    const config: Config = ZodConfig.parse(JSON.parse(configString));
    config.devices.forEach((device) => {
      const a = getDeviceScript({ config, deviceConfig: device });
      console.log(`#device ${device.hostname}`)
      console.log(a.join('\n'))
    });
  }
};

main();
