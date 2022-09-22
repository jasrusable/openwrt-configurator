#!/usr/bin/env node

import fs from "fs";
import commandLineArgs from "command-line-args";
import commandLineUsage from "command-line-usage";
import { z } from "zod";
import { deviceSchema } from "./deviceConfig/configSchema";
import { getDeviceScript2 } from "../openWRTConfigSchema";
import { firewallProtocols, firewallTargets, icmpTypes } from "../openwrtValues";

export enum Roles {
  AP = "ap",
  Router = "router",
}

export enum WifiEncryption {
  Psk2 = "psk2",
  None = "none",
}

const ports = z.union([z.array(z.number()), z.string()]);

const configSchema = z
  .object({
    devices: z.array(
      z.object({
        deviceId: z.string(),
        version: z.string(),
        roles: z.array(z.nativeEnum(Roles)),
        system: z.object({
          hostname: z.string(),
        }),
      })
    ),
    system: z
      .object({
        timezone: z.string(),
      })
      .strict(),
    firewall: z.object({
      defaults: z.object({
        input: z.enum(firewallTargets),
        output: z.enum(firewallTargets),
        forward: z.enum(firewallTargets),
        synflood_protect: z.boolean().optional(),
      }),
      zones: z.array(
        z.object({
          name: z.string(),
          input: z.enum(firewallTargets),
          output: z.enum(firewallTargets),
          forward: z.enum(firewallTargets),
          masq: z.boolean().optional(),
          mtu_fix: z.boolean().optional(),
          network: z.array(z.string()),
        })
      ),
      forwardings: z.array(
        z.object({
          src: z.string(),
          dest: z.string(),
        })
      ),
      rules: z.array(
        z.object({
          name: z.string(),
          proto: z.array(z.enum(firewallProtocols)).optional(),
          icmp_type: z.array(z.enum(icmpTypes)).optional(),
          src: z.string().optional(),
          src_ip: z.array(z.string()).optional(),
          src_port: ports.optional(),
          dest: z.string().optional(),
          dest_ip: z.array(z.string()).optional(),
          dest_port: ports.optional(),
          target: z.enum(firewallTargets),
          family: z.array(z.enum(["ipv4", "ipv6"])).optional(),
          limit: z.string().optional(),
          enabled: z.boolean().optional(),
        })
      ),
    }),
    network: z.object({
      networks: z.array(
        z.object({
          name: z.string(),
          router: z
            .object({
              device: z.string().optional(),
              proto: z.enum(["static", "dhcp", "pppoe"]),
              ipaddr: z.string().optional(),
              netmask: z.string().optional(),
            })
            .optional(),
          devices: z
            .object({
              proto: z.enum(["dhcp"]),
            })
            .optional(),
          vlan: z.number().optional(),
          vlan_untagged: z.boolean().optional(),
        })
      ),
    }),
    wireless: z.object({
      "wifi-iface": z.array(
        z.object({
          mode: z.enum(["ap"]),
          ssid: z.string(),
          encryption: z.nativeEnum(WifiEncryption),
          key: z.string().optional(),
          network: z.string(),
        })
      ),
    }),
    dhcp: z.object({
      dnsmasq: z.object({
        domainneeded: z.boolean(),
        localise_queries: z.boolean(),
        rebind_localhost: z.boolean(),
        local: z.string(),
        expandhosts: z.boolean(),
        authoritative: z.boolean(),
        readethers: z.boolean(),
        leasefile: z.string(),
        localservice: z.boolean(),
        ednspacket_max: z.number(),
        dnsforwardmax: z.number(),
        domain: z.string(),
        noresolv: z.boolean(),
        server: z.array(z.string()),
      }),
    }),
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
      const a = getDeviceScript2({
        config,
        deviceConfig: deviceConfig,
        deviceSchema: device,
      });
      console.log(`#device ${deviceConfig.system.hostname}`);
      console.log(a.join("\n"));
    });
  }
};

main();
