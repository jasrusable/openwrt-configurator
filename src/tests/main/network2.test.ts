import test from "ava";
import { fixtureConfig } from "../helpers/fixtures";
import { getDeviceSchema } from "../../getDeviceSchema";
import { getOpenWrtConfig } from "../../engine/getOpenWrtConfig";
import { nodePlatform } from "../../platforms/node";

const { plan, deviceConfigs } = fixtureConfig("config2.json");

test("network", async (t) => {
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

  // Ensure no bridge-vlan on swconfig ap.
  t.is(routerOpenWrtConfig.network?.["bridge-vlan"] as unknown, undefined);

  // Ensure switch0 is defined.
  t.is(routerOpenWrtConfig.network?.switch?.[0].name, "switch0");
  t.is(routerOpenWrtConfig.network?.switch?.[0].name, "switch0");
  t.is(routerOpenWrtConfig.network?.switch?.[0].reset, true);
  t.is(routerOpenWrtConfig.network?.switch?.[0].enable_vlan, true);

  // Ensure switch_vlans are defined.
  t.is(routerOpenWrtConfig.network?.switch_vlan?.[0][".name"], "switchvlan0");
  t.is(routerOpenWrtConfig.network?.switch_vlan?.[0].device, "switch0");
  t.is(routerOpenWrtConfig.network?.switch_vlan?.[0].vlan, 1);
  t.deepEqual(
    routerOpenWrtConfig.network?.switch_vlan?.[0].ports,
    "6t 1 2 3 4"
  );
  t.is(routerOpenWrtConfig.network?.switch_vlan?.[1][".name"], "switchvlan1");
  t.is(routerOpenWrtConfig.network?.switch_vlan?.[1].device, "switch0");
  t.is(routerOpenWrtConfig.network?.switch_vlan?.[1].vlan, 2);
  t.deepEqual(routerOpenWrtConfig.network?.switch_vlan?.[1].ports, "6t 0");

  // Ensure br-lan.1 device is defined.
  t.is(routerOpenWrtConfig.network?.device?.[0][".name"], "device0");
  t.is(routerOpenWrtConfig.network?.device?.[0].name, "br-lan.1");
  t.is(routerOpenWrtConfig.network?.device?.[0].type, "bridge");
  t.is((routerOpenWrtConfig.network?.device?.[0].ports as string[]).length, 1);
  t.deepEqual(routerOpenWrtConfig.network?.device?.[0].ports, ["eth0.1"]);

  // Ensure loopback interface is defined
  t.is(routerOpenWrtConfig.network?.interface?.[0][".name"], "loopback");
  t.is(routerOpenWrtConfig.network?.interface?.[0].device, "lo");
  t.is(routerOpenWrtConfig.network?.interface?.[0].proto, "static");
  t.is(routerOpenWrtConfig.network?.interface?.[0].ipaddr, "127.0.0.1");
  t.is(routerOpenWrtConfig.network?.interface?.[0].netmask, "255.0.0.0");

  // Ensure lan interface is defined
  t.is(routerOpenWrtConfig.network?.interface?.[1][".name"], "wan");
  t.is(routerOpenWrtConfig.network?.interface?.[1].device, "eth0.2");
  t.is(routerOpenWrtConfig.network?.interface?.[1].proto, "pppoe");

  // Ensure guest interface is defined
  t.is(routerOpenWrtConfig.network?.interface?.[2][".name"], "lan");
  t.is(routerOpenWrtConfig.network?.interface?.[2].device, "br-lan.1");
  t.is(routerOpenWrtConfig.network?.interface?.[2].proto, "static");
});
