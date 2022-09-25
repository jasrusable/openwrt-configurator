import fs from "fs";
import { deviceSchemaSchema } from "../src/deviceSchema";
import { ONCConfig, oncConfigSchema } from "../src/oncConfigSchema";
import { getDeviceScript } from "../src/getDeviceScript";
import { program } from "commander";
import { provisionConfig } from "../src/provisionConfig";
import { getDeviceSchema } from "../src/getDeviceSchema";

export const main = async () => {
  program.name("ONC").description("Open Network Controller").version("0.0.1");

  program
    .command("provision")
    .description("Provision configuration to devices.")
    .requiredOption("-c, --config <config>")
    .action(async (args) => {
      const oncConfigString = fs.readFileSync(args.config, "utf-8");
      const oncConfig: ONCConfig = oncConfigSchema.parse(
        JSON.parse(oncConfigString)
      );

      const deviceConfigs = oncConfig.devices.filter(
        (device) => device.enabled !== false
      );

      const deviceSchemas = await Promise.all(
        deviceConfigs.map(async (deviceConfig) => {
          const deviceSchema = await getDeviceSchema({ deviceConfig });
          return deviceSchema;
        })
      );

      await provisionConfig({ oncConfig, deviceSchemas });
    });

  program
    .command("uci-commands")
    .description("Print uci commands")
    .requiredOption("-c, --config <config>")
    .action(async (args) => {
      const oncConfigString = fs.readFileSync(args.config, "utf-8");
      const oncConfig: ONCConfig = oncConfigSchema.parse(
        JSON.parse(oncConfigString)
      );
      const deviceConfigs = oncConfig.devices.filter(
        (device) => device.enabled !== false
      );

      const deviceSchemas = await Promise.all(
        deviceConfigs.map(async (deviceConfig) => {
          const deviceSchema = await getDeviceSchema({ deviceConfig });
          return deviceSchema;
        })
      );

      for (const deviceConfig of deviceConfigs) {
        const deviceSchema = deviceSchemas.find(
          (schema) => schema.name === deviceConfig.deviceModelId
        );
        if (!deviceSchema) {
          throw new Error(
            `Device schema not found for device model: ${deviceConfig.deviceModelId}`
          );
        }
        const commands = getDeviceScript({
          oncConfig: oncConfig,
          deviceConfig: deviceConfig,
          deviceSchema,
        });
        console.log(`#device ${deviceConfig.system.hostname}`);
        console.log(commands.join("\n"));
      }
    });

  await program.parseAsync();
  process.exit(0);
};

main();
