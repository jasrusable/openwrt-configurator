import test from "ava";
import { join } from "path";
import { readFileSync } from "fs";
import { getDeviceSchema } from "../../getDeviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { ONCConfig, oncConfigSchema } from "../../oncConfigSchema";
import { parseJson, parseSchema } from "../../utils";

const oncConfigString = readFileSync(join(__dirname, "./config.json"), "utf-8");
const oncJson = parseJson(oncConfigString);
const oncConfig: ONCConfig = parseSchema(oncConfigSchema, oncJson);
const deviceConfigs = oncConfig.devices.filter(
  (device) => device.enabled !== false
);

test("network", async (t) => {
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

  // Ensure no switch or switch_vlan on DSA router.
  t.is(routerOpenWrtConfig.network?.switch, undefined);
  t.is(routerOpenWrtConfig.network?.switch_vlan, undefined);

  // Ensure br-lan device is defined.
  t.is(routerOpenWrtConfig.network?.device?.[0][".name"], "device0");
  t.is(routerOpenWrtConfig.network?.device?.[0].name, "br-lan");
  t.is(routerOpenWrtConfig.network?.device?.[0].type, "bridge");
  t.is(routerOpenWrtConfig.network?.device?.[0].ports.length, 4);
  t.deepEqual(routerOpenWrtConfig.network?.device?.[0].ports, [
    "eth1",
    "eth2",
    "eth3",
    "eth4",
  ]);

  t.is(routerOpenWrtConfig.network?.["bridge-vlan"]?.[0].device, "br-lan");
  t.deepEqual(routerOpenWrtConfig.network?.["bridge-vlan"]?.[0].ports, [
    "eth1",
    "eth2",
    "eth3",
    "eth4",
  ]);
  t.is(routerOpenWrtConfig.network?.["bridge-vlan"]?.[1].device, "br-lan");
  t.deepEqual(routerOpenWrtConfig.network?.["bridge-vlan"]?.[1].ports, [
    "eth1:t",
    "eth2:t",
    "eth3:t",
    "eth4:t",
  ]);

  // Ensure loopback interface is defined
  t.is(routerOpenWrtConfig.network?.interface?.[0][".name"], "loopback");
  t.is(routerOpenWrtConfig.network?.interface?.[0].device, "lo");
  t.is(routerOpenWrtConfig.network?.interface?.[0].proto, "static");
  t.is(routerOpenWrtConfig.network?.interface?.[0].ipaddr, "127.0.0.1");
  t.is(routerOpenWrtConfig.network?.interface?.[0].netmask, "255.0.0.0");

  // Ensure wan interface is defined
  t.is(routerOpenWrtConfig.network?.interface?.[1][".name"], "wan");
  t.is(routerOpenWrtConfig.network?.interface?.[1].device, "eth0");
  t.is(routerOpenWrtConfig.network?.interface?.[1].proto, "pppoe");

  // Ensure lan interface is defined
  t.is(routerOpenWrtConfig.network?.interface?.[2][".name"], "lan");
  t.is(routerOpenWrtConfig.network?.interface?.[2].device, "br-lan.1");
  t.is(routerOpenWrtConfig.network?.interface?.[2].proto, "static");
  t.is(routerOpenWrtConfig.network?.interface?.[2].ipaddr, "10.0.0.1");
  t.is(routerOpenWrtConfig.network?.interface?.[2].netmask, "255.255.0.0");

  // Ensure guest interface is defined
  t.is(routerOpenWrtConfig.network?.interface?.[3][".name"], "guest");
  t.is(routerOpenWrtConfig.network?.interface?.[3].device, "br-lan.2");
  t.is(routerOpenWrtConfig.network?.interface?.[3].proto, "static");
  t.is(routerOpenWrtConfig.network?.interface?.[3].ipaddr, "10.1.0.1");
  t.is(routerOpenWrtConfig.network?.interface?.[2].netmask, "255.255.0.0");

  const apDeviceConfig = deviceConfigs[1];
  const apDeviceSchema = deviceSchemas[1];
  const apOpenWrtConfig = getOpenWrtConfig({
    oncConfig,
    deviceConfig: apDeviceConfig,
    deviceSchema: apDeviceSchema,
  });
  t.is(apOpenWrtConfig.system?.system?.[0]?.hostname, "my-ap-1");
  t.is(apOpenWrtConfig.system?.system?.[0]?.timezone, "Africa/Johannesburg");

  // Ensure no bridge-vlan on swconfig ap.
  t.is(apOpenWrtConfig.network?.["bridge-vlan"], undefined);

  // Ensure switch0 is defined.
  t.is(apOpenWrtConfig.network?.switch?.[0].name, "switch0");
  t.is(apOpenWrtConfig.network?.switch?.[0].name, "switch0");
  t.is(apOpenWrtConfig.network?.switch?.[0].reset, true);
  t.is(apOpenWrtConfig.network?.switch?.[0].enable_vlan, true);

  // Ensure switch_vlans are defined.
  t.is(apOpenWrtConfig.network?.switch_vlan?.[0][".name"], "switchvlan0");
  t.is(apOpenWrtConfig.network?.switch_vlan?.[0].device, "switch0");
  t.is(apOpenWrtConfig.network?.switch_vlan?.[0].vlan, 1);
  t.deepEqual(apOpenWrtConfig.network?.switch_vlan?.[0].ports, "6t 0 1 2 3 4");
  t.is(apOpenWrtConfig.network?.switch_vlan?.[1][".name"], "switchvlan1");
  t.is(apOpenWrtConfig.network?.switch_vlan?.[1].device, "switch0");
  t.is(apOpenWrtConfig.network?.switch_vlan?.[1].vlan, 2);
  t.deepEqual(
    apOpenWrtConfig.network?.switch_vlan?.[1].ports,
    "6t 0t 1t 2t 3t 4t"
  );

  // Ensure br-lan.1 device is defined.
  t.is(apOpenWrtConfig.network?.device?.[0][".name"], "device0");
  t.is(apOpenWrtConfig.network?.device?.[0].name, "br-lan.1");
  t.is(apOpenWrtConfig.network?.device?.[0].type, "bridge");
  t.is(apOpenWrtConfig.network?.device?.[0].ports.length, 1);
  t.deepEqual(apOpenWrtConfig.network?.device?.[0].ports, ["eth0.1"]);

  // Ensure br-lan.2 device is defined.
  t.is(apOpenWrtConfig.network?.device?.[1][".name"], "device1");
  t.is(apOpenWrtConfig.network?.device?.[1].name, "br-lan.2");
  t.is(apOpenWrtConfig.network?.device?.[1].type, "bridge");
  t.is(apOpenWrtConfig.network?.device?.[1].ports.length, 1);
  t.deepEqual(apOpenWrtConfig.network?.device?.[1].ports, ["eth0.2"]);

  // Ensure loopback interface is defined
  t.is(apOpenWrtConfig.network?.interface?.[0][".name"], "loopback");
  t.is(apOpenWrtConfig.network?.interface?.[0].device, "lo");
  t.is(apOpenWrtConfig.network?.interface?.[0].proto, "static");
  t.is(apOpenWrtConfig.network?.interface?.[0].ipaddr, "127.0.0.1");
  t.is(apOpenWrtConfig.network?.interface?.[0].netmask, "255.0.0.0");

  // Ensure lan interface is defined
  t.is(apOpenWrtConfig.network?.interface?.[1][".name"], "lan");
  t.is(apOpenWrtConfig.network?.interface?.[1].device, "br-lan.1");
  t.is(apOpenWrtConfig.network?.interface?.[1].proto, "dhcp");

  // Ensure guest interface is defined
  t.is(apOpenWrtConfig.network?.interface?.[2][".name"], "guest");
  t.is(apOpenWrtConfig.network?.interface?.[2].device, "br-lan.2");
  t.is(apOpenWrtConfig.network?.interface?.[2].proto, "dhcp");
});
