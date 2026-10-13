import test from "ava";
import { fixtureConfig } from "../helpers/fixtures";
import { getDeviceSchema } from "../../getDeviceSchema";
import { getOpenWrtConfig } from "../../engine/getOpenWrtConfig";
import { nodePlatform } from "../../platforms/node";

const { plan, deviceConfigs } = fixtureConfig("config.json");

test("system", async (t) => {
  const deviceSchemas = await Promise.all(
    deviceConfigs.map(async (deviceConfig) => {
      const deviceSchema = await getDeviceSchema({
        deviceConfig,
        local: nodePlatform,
      });
      return deviceSchema;
    })
  );

  const routerDeviceConfig = deviceConfigs[0];
  const routerDeviceSchema = deviceSchemas[0];
  const routerOpenWrtConfig = getOpenWrtConfig({
    plan,
    deviceConfig: routerDeviceConfig,
    deviceSchema: routerDeviceSchema,
  });
  t.is(routerOpenWrtConfig.system?.system?.[0]?.hostname, "my-router");
  t.is(
    routerOpenWrtConfig.system?.system?.[0]?.timezone,
    "Africa/Johannesburg"
  );

  const apDeviceConfig = deviceConfigs[1];
  const apDeviceSchema = deviceSchemas[1];
  const apOpenWrtConfig = getOpenWrtConfig({
    plan,
    deviceConfig: apDeviceConfig,
    deviceSchema: apDeviceSchema,
  });
  t.is(apOpenWrtConfig.system?.system?.[0]?.hostname, "my-ap-1");
  t.is(apOpenWrtConfig.system?.system?.[0]?.timezone, "Africa/Johannesburg");
});
