import { readFileSync } from "fs";
import { ONCConfig, oncConfigSchema } from "../src/oncConfigSchema";
import { getDeviceScript } from "../src/getDeviceScript";
import { program } from "commander";
import { provisionConfig } from "../src/provisionConfig";
import { getDeviceSchema } from "../src/getDeviceSchema";
import { parseSchema } from "../src/utils";
import { getOpenWrtConfig } from "../src/getOpenWrtConfig";

export const main = async () => {
  program.name("ONC").description("Open Network Controller").version("0.0.1");

  program
    .command("provision")
    .description("provision configuration to devices")
    .requiredOption("-c, --config <config>")
    .action(async (args) => {
      const oncConfigString = readFileSync(args.config, "utf-8");
      const oncJson = JSON.parse(oncConfigString);
      const oncConfig: ONCConfig = parseSchema(oncConfigSchema, oncJson);
      await provisionConfig({ oncConfig });
    });

  program
    .command("print-uci-commands")
    .description("print uci commands for configuration")
    .requiredOption("-c, --config <config>")
    .action(async (args) => {
      const oncConfigString = readFileSync(args.config, "utf-8");
      const oncJson = JSON.parse(oncConfigString);
      const oncConfig: ONCConfig = parseSchema(oncConfigSchema, oncJson);
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
          (schema) => schema.name === deviceConfig.model_id
        );
        if (!deviceSchema) {
          throw new Error(
            `Device schema not found for device model: ${deviceConfig.model_id}`
          );
        }
        const openWrtConfig = getOpenWrtConfig({
          oncConfig: oncConfig,
          deviceConfig,
          deviceSchema,
        });
        const commands = getDeviceScript({ openWrtConfig });
        console.log(`#device ${deviceConfig.hostname}`);
        console.log(commands.join("\n"));
      }
    });

  await program.parseAsync();
  process.exit(0);
};

main();
