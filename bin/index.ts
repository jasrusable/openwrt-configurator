import commandLineArgs from "command-line-args";
import commandLineUsage from "command-line-usage";
import fs from "fs";
import { deviceSchema } from "../src/deviceSchema";
import { ONCConfig, oncConfigSchema } from "../src/oncConfigSchema";
import { getDeviceScript } from "../src/getDeviceScript";

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
    const oncConfigString = fs.readFileSync(options.config, "utf-8");
    const oncConfig: ONCConfig = oncConfigSchema.parse(
      JSON.parse(oncConfigString)
    );

    oncConfig.devices.forEach((deviceConfig) => {
      const device = deviceSchema.parse(
        JSON.parse(
          fs.readFileSync(
            `./deviceSchemas/${deviceConfig.deviceId}.json`,
            "utf-8"
          )
        )
      );
      const commands = getDeviceScript({
        oncConfig: oncConfig,
        deviceConfig: deviceConfig,
        deviceSchema: device,
      });
      console.log(`#device ${deviceConfig.system.hostname}`);
      console.log(commands.join("\n"));
    });
  }
};

main();
