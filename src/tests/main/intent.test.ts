import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { compileIntent } from "../../intent/compile";
import { ulaPrefix } from "../../intent/features/network";
import { intentSchema } from "../../intent/schema";
import { oncConfigSchema } from "../../oncConfigSchema";

const root = join(__dirname, "../../..");
const sample = () =>
  JSON.parse(readFileSync(join(root, "sampleConfigs/intent.json"), "utf8"));
const compile = (intent = sample()) =>
  oncConfigSchema.parse(compileIntent(intentSchema.parse(intent)));

// Real hardware, captured read-only from the user's devices: the compiled
// config must resolve on each, exactly as a hand-written one would.
const onDevice = (hostname: string, model: string) => {
  const oncConfig = compile();
  const deviceSchema = deviceSchemaSchema.parse(
    JSON.parse(
      readFileSync(join(root, "deviceSchemas", `${model}.json`), "utf8")
    )
  );
  const deviceConfig = oncConfig.devices.find((d) => d.hostname === hostname)!;
  return getOpenWrtConfig({ oncConfig, deviceConfig, deviceSchema }) as any;
};

test("the sample intent compiles to a valid low-level config", (t) => {
  const config = compile();
  t.deepEqual(
    config.devices.map((d) => [d.hostname, d.tags.role, d.ipaddr]),
    [
      ["home-router", "router", "10.0.0.1"],
      ["home-ap-1", "access-point", "home-ap-1.lan"],
    ]
  );
  // No device facts: the model is read from the device when provisioning.
  t.true(config.devices.every((d) => d.model_id === undefined));
});

test("on the router: WAN on the board's WAN port, everything else bridged", (t) => {
  const config = onDevice("home-router", "friendlyarm,nanopi-r6s");
  const wan = config.network.interface.find((i: any) => i[".name"] === "wan");
  t.is(wan.device, "eth1", "@wan_port is the port board.json calls wan");
  t.is(config.sqm.queue[0].interface, "eth1");
  t.is(config.sqm.queue[0].download, "950000");
  t.deepEqual(config.network.device[0].ports, ["eth0", "eth2"]);
  t.deepEqual(config.dhcp.dnsmasq[0].server, ["127.0.0.1#5053"]);
  t.is(wan.peerdns, false, "encrypted DNS ignores the ISP's resolvers");
  t.is(config.system.system[0].timezone, "CET-1CEST,M3.5.0,M10.5.0/3");
  t.false("wireless" in config, "the router has no radios and no Wi-Fi");
});

test("on the access point: bridged, a DHCP client, Wi-Fi on both bands", (t) => {
  const config = onDevice("home-ap-1", "zyxel,nwa50ax-pro");
  const lan = config.network.interface.find((i: any) => i[".name"] === "lan");
  t.is(lan.proto, "dhcp");
  t.deepEqual(
    config.wireless["wifi-device"].map((r: any) => [r.band, r.channel]),
    [
      ["2g", 11],
      ["5g", 36],
    ]
  );
  t.is(config.wireless["wifi-iface"].length, 2, "one network, two bands");
  t.true(
    Object.values(config.firewall ?? {}).every((s: any) => s.length === 0),
    "no firewall sections"
  );
  t.is(config.ubihealthd["ubi-device"][0].device, "/dev/ubi0");
});

test("the intent is checked before it compiles", (t) => {
  const bad = (change: (intent: any) => void) => {
    const intent = sample();
    change(intent);
    return () => intentSchema.parse(intent);
  };
  t.throws(
    bad((i) => i.devices.push({ name: "second", role: "router" })),
    { message: /exactly one device must be the router/ }
  );
  t.throws(bad((i) => (i.site.timezone = "Mars/Olympus")), {
    message: /IANA zone/,
  });
  t.throws(bad((i) => (i.wifi[0].password = "short")), {
    message: /at least 8/,
  });
  t.throws(bad((i) => (i.devices[0].model_id = "x")), {
    message: /Unrecognized key/,
  });
});

test("the ULA prefix is stable and well-formed", (t) => {
  t.is(ulaPrefix("Home"), ulaPrefix("Home"));
  t.not(ulaPrefix("Home"), ulaPrefix("Cabin"));
  t.regex(ulaPrefix("Home"), /^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48$/);
});
