import test from "ava";
import { join } from "path";
import { readFileSync } from "fs";
import { getDeviceSchema } from "../../getDeviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { getUciCommands } from "../../getUciCommands";
import { ONCConfig, oncConfigSchema } from "../../oncConfigSchema";
import { parseJson, parseSchema } from "../../utils";

const oncConfigString = readFileSync(join(__dirname, "./config.json"), "utf-8");
const oncJson = parseJson(oncConfigString);
const oncConfig: ONCConfig = parseSchema(oncConfigSchema, oncJson);
const deviceConfigs = oncConfig.devices.filter(
  (device) => device.enabled !== false
);

test("station PSK shorter than 8 characters is rejected", (t) => {
  const err = t.throws(() =>
    parseSchema(oncConfigSchema, {
      ...oncJson,
      config: {
        ...oncJson.config,
        wireless: {
          "wifi-iface": [
            {
              mode: "ap",
              device: "*",
              ssid: "x",
              key: "longenough",
              encryption: "psk2",
              stations: [{ key: "test" }],
            },
          ],
        },
      },
    })
  );
  t.true(String(err).includes("WPA PSK must be 8-63 characters"));
});

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
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[0][".name"], "wifidevice0");
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[0].band, "2g");
  t.is(
    apOpenWrtConfig.wireless?.["wifi-device"]?.[0].path,
    "platform/10300000.wmac"
  );
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[0].type, "mac80211");
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[1][".name"], "wifidevice1");
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[1].band, "5g");
  t.is(
    apOpenWrtConfig.wireless?.["wifi-device"]?.[1].path,
    "pci0000:00/0000:00:00.0/0000:01:00.0"
  );
  t.is(apOpenWrtConfig.wireless?.["wifi-device"]?.[0].type, "mac80211");

  // Test wifi-face
  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[0][".name"], "wifinet00");
  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[0].device, "wifidevice0");
  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[0].network, "lan");

  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[1][".name"], "wifinet01");
  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[1].device, "wifidevice1");
  t.is(apOpenWrtConfig.wireless?.["wifi-iface"]?.[1].network, "lan");
  t.is(
    (apOpenWrtConfig.wireless?.["wifi-iface"]?.[0] as { stations?: unknown })
      .stations,
    undefined
  );

  const stations = apOpenWrtConfig.wireless?.["wifi-station"] || [];
  t.is(stations.length, 4);
  t.deepEqual(
    stations.map((station) => ({
      name: station[".name"],
      iface: station.iface,
      key: station.key,
      mac: station.mac,
    })),
    [
      {
        name: "wifistation000",
        iface: "wifinet00",
        key: "housekey123",
        mac: "00:00:00:00:00:00",
      },
      {
        name: "wifistation001",
        iface: "wifinet00",
        key: "guestkey123",
        mac: "00:00:00:00:00:00",
      },
      {
        name: "wifistation010",
        iface: "wifinet01",
        key: "housekey123",
        mac: "00:00:00:00:00:00",
      },
      {
        name: "wifistation011",
        iface: "wifinet01",
        key: "guestkey123",
        mac: "00:00:00:00:00:00",
      },
    ]
  );

  const uci = getUciCommands({ openWrtConfig: apOpenWrtConfig });
  t.true(uci.includes("uci set wireless.wifistation000=wifi-station"));
  t.true(uci.includes("uci set wireless.wifistation000.iface='wifinet00'"));
  t.true(uci.includes("uci set wireless.wifistation000.key='housekey123'"));
});
