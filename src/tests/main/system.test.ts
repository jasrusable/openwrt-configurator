import test from "ava";
import { join } from "path";
import { readFileSync } from "fs";
import { getDeviceSchema } from "../../getDeviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { ONCConfig, oncConfigSchema } from "../../oncConfigSchema";
import { parseSchema } from "../../utils";

const oncConfigString = readFileSync(join(__dirname, "./config.json"), "utf-8");
const oncJson = JSON.parse(oncConfigString);
const oncConfig: ONCConfig = parseSchema(oncConfigSchema, oncJson);
const deviceConfigs = oncConfig.devices.filter(
  (device) => device.enabled !== false
);

test("system", async (t) => {
  const deviceSchemas = await Promise.all(
    deviceConfigs.map(async (deviceConfig) => {
      const deviceSchema = await getDeviceSchema({
        deviceConfig,
        useLocal: true,
      });
      return deviceSchema;
    })
  );

  const routerDeviceConfig = deviceConfigs[0];
  const routerDeviceSchema = deviceSchemas[0];
  const routerOpenWrtConfig = getOpenWrtConfig({
    oncConfig,
    deviceConfig: routerDeviceConfig,
    deviceSchema: routerDeviceSchema,
  });
  t.is(
    routerOpenWrtConfig.system?.system?.[0]?.properties.hostname,
    "my-router"
  );
  t.is(
    routerOpenWrtConfig.system?.system?.[0]?.properties.timezone,
    "Africa/Johannesburg"
  );

  const apDeviceConfig = deviceConfigs[1];
  const apDeviceSchema = deviceSchemas[1];
  const apOpenWrtConfig = getOpenWrtConfig({
    oncConfig,
    deviceConfig: apDeviceConfig,
    deviceSchema: apDeviceSchema,
  });
  t.is(apOpenWrtConfig.system?.system?.[0]?.properties.hostname, "my-ap-1");
  t.is(
    apOpenWrtConfig.system?.system?.[0]?.properties.timezone,
    "Africa/Johannesburg"
  );
});
