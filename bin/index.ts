import commandLineArgs from "command-line-args";
import commandLineUsage from "command-line-usage";
import fs from "fs";
import { deviceSchema } from "../src/deviceSchema";
import { ONCConfig, oncConfigSchema } from "../src/oncConfigSchema";
import { getDeviceScript } from "../src/getDeviceScript";
import { provisionOpenWRTDevice } from "../src/provisionOpenWRTDevice";
import { getOpenWRTConfig } from "../src/getOpenWRTConfig";

const optionDefinitions = [
  {
    name: "config",
    type: String,
    description: "Path to a config file.",
  },
  { name: "help", description: "Print this usage guide." },
];

export const main = async () => {
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
    const oncConfigString = fs.readFileSync(options.config, "utf-8");
    const oncConfig: ONCConfig = oncConfigSchema.parse(
      JSON.parse(oncConfigString)
    );

    const deviceConfigs = oncConfig.devices.filter(
      (device) => device.enabled !== false
    );

    for (const deviceConfig of deviceConfigs) {
      const parsedDeviceSchema = deviceSchema.parse(
        JSON.parse(
          fs.readFileSync(
            `./deviceSchemas/${deviceConfig.deviceId}.json`,
            "utf-8"
          )
        )
      );

      if (
        deviceConfig.untagged_vlan_ip &&
        deviceConfig.provisioning_config?.ssh_auth
      ) {
        const openWRTConfig = getOpenWRTConfig({
          oncConfig,
          deviceConfig: deviceConfig,
          deviceSchema: parsedDeviceSchema,
        });

        await provisionOpenWRTDevice({
          deviceId: deviceConfig.deviceId,
          deviceVersion: deviceConfig.version,
          ipAddress: deviceConfig.untagged_vlan_ip,
          auth: deviceConfig.provisioning_config.ssh_auth,
          openWRTConfig,
        });
      }
    }

    // deviceConfigs.forEach((deviceConfig) => {
    //   const device = deviceSchema.parse(
    //     JSON.parse(
    //       fs.readFileSync(
    //         `./deviceSchemas/${deviceConfig.deviceId}.json`,
    //         "utf-8"
    //       )
    //     )
    //   );
    //   const commands = getDeviceScript({
    //     oncConfig: oncConfig,
    //     deviceConfig: deviceConfig,
    //     deviceSchema: device,
    //   });
    //   console.log(`#device ${deviceConfig.system.hostname}`);
    //   console.log(commands.join("\n"));
    // });
  }

  process.exit(0);
};

main();
