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

test("wireless", async (t) => {
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
  t.is(routerOpenWrtConfig.wireless, undefined);

  const apDeviceConfig = deviceConfigs[1];
  const apDeviceSchema = deviceSchemas[1];
  const apOpenWrtConfig = getOpenWrtConfig({
    oncConfig,
    deviceConfig: apDeviceConfig,
    deviceSchema: apDeviceSchema,
  });

  // Test wifi-device
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[0][".name"], "radio0");
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[0].band, "2g");
  t.is(
    apOpenWrtConfig.wireless?.["wifi-device"]?.[0].path,
    "platform/10300000.wmac"
  );
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[0].type, "mac80211");
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[1][".name"], "radio1");
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[1].band, "5g");
  t.is(
    apOpenWrtConfig.wireless?.["wifi-device"]?.[1].path,
    "pci0000:00/0000:00:00.0/0000:01:00.0"
  );
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[0].type, "mac80211");

  // Test wifi-face
  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[0][".name"], "wifinet02g");
  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[0].device, "radio0");
  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[0].network, "lan");
});
