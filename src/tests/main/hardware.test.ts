import test from "ava";
import { DeviceSchema, deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { oncConfigSchema } from "../../oncConfigSchema";
import { readFileSync } from "fs";
import { join } from "path";
import { parseDeviceFacts } from "../../facts/board";

// The hardware abstraction, one rule at a time, against small made-up devices.
const device = { model_id: "test,device", hostname: "box", tags: {} };
const build = (config: object, schema: Partial<DeviceSchema>) =>
  getOpenWrtConfig({
    oncConfig: oncConfigSchema.parse({ devices: [device], config }),
    deviceConfig: device as any,
    deviceSchema: deviceSchemaSchema.parse({
      name: "test,device",
      version: "25.12.5",
      ...schema,
    }),
  }) as any;

const dsa = {
  sw_config: false,
  ports: [
    { name: "eth0", default_role: "wan" as const },
    { name: "eth1", default_role: "lan" as const },
    { name: "eth2", default_role: "lan" as const },
  ],
};
const swconfig = {
  sw_config: true,
  ports: [
    { name: "port0", switch_port: 0, sw_config_cpu_name: "eth0" },
    { name: "port1", switch_port: 1 },
    { name: "port2", switch_port: 2 },
  ],
};
const twoRadios = {
  radios: [
    {
      name: "radio0",
      type: "mac80211" as const,
      path: "p0",
      band: "2g" as const,
    },
    {
      name: "radio1",
      type: "mac80211" as const,
      path: "p1",
      band: "5g" as const,
    },
  ],
};

test('a "*" bridge takes every physical port nothing else uses', (t) => {
  const config = build(
    {
      network: {
        device: [{ name: "br-lan", type: "bridge", ports: "*" }],
        interface: [{ ".name": "wan", device: "eth0", proto: "dhcp" }],
      },
    },
    dsa
  );
  t.deepEqual(config.network.device[0].ports, ["eth1", "eth2"]);
});

test('ports named by another bridge are not taken by a "*" one', (t) => {
  const config = build(
    {
      network: {
        device: [
          { name: "br-iot", type: "bridge", ports: ["eth2"] },
          { name: "br-lan", type: "bridge", ports: "*" },
        ],
      },
    },
    dsa
  );
  t.deepEqual(config.network.device[1].ports, ["eth0", "eth1"]);
});

test('bridge-vlan "*" is untagged on the bridge\'s ports, "*t" tagged', (t) => {
  const config = build(
    {
      network: {
        device: [{ name: "br-lan", type: "bridge", ports: ["eth1", "eth2"] }],
        "bridge-vlan": [
          { device: "br-lan", vlan: 1, ports: "*" },
          { device: "br-lan", vlan: 2, ports: "*t" },
        ],
      },
    },
    dsa
  );
  t.deepEqual(config.network["bridge-vlan"][0].ports, ["eth1", "eth2"]);
  t.deepEqual(config.network["bridge-vlan"][1].ports, ["eth1:t", "eth2:t"]);
});

test("bridge-vlan with an explicit port list keeps it as written", (t) => {
  const config = build(
    {
      network: {
        device: [{ name: "br-lan", type: "bridge", ports: ["eth1", "eth2"] }],
        "bridge-vlan": [
          { device: "br-lan", vlan: 3, ports: ["eth1:t", "eth2"] },
        ],
      },
    },
    dsa
  );
  t.deepEqual(config.network["bridge-vlan"][0].ports, ["eth1:t", "eth2"]);
});

test("@cpu_port names the switch's CPU port, with an optional VLAN", (t) => {
  const config = build(
    {
      network: {
        device: [{ name: "br-lan.1", type: "bridge", ports: ["@cpu_port.1"] }],
      },
    },
    swconfig
  );
  t.deepEqual(config.network.device[0].ports, ["eth0.1"]);
  t.throws(
    () =>
      build(
        {
          network: {
            device: [{ name: "br", type: "bridge", ports: ["@cpu_port"] }],
          },
        },
        dsa
      ),
    { message: /CPU port not defined/ }
  );
});

test('switch_vlan "*" lists the CPU port tagged then every port, "*t" all tagged', (t) => {
  const config = build(
    {
      network: {
        switch_vlan: [
          { device: "switch0", vlan: 1, ports: "*" },
          { device: "switch0", vlan: 2, ports: "*t" },
        ],
      },
    },
    swconfig
  );
  t.is(config.network.switch_vlan[0].ports, "0t 1 2");
  t.is(config.network.switch_vlan[1].ports, "0t 1t 2t");
});

test("each radio gets a wifi-device, matched to config by band, with a default channel", (t) => {
  const config = build(
    {
      wireless: {
        "wifi-device": [{ ".name": "five", band: "5g", channel: 149 }],
      },
    },
    twoRadios
  );
  const [two, five] = config.wireless["wifi-device"];
  t.like(two, { band: "2g", channel: 11, path: "p0", type: "mac80211" });
  t.like(five, { ".name": "five", band: "5g", channel: 149, path: "p1" });
});

test("two radios in the same band get distinct names", (t) => {
  const config = build(
    { wireless: { "wifi-device": [{ ".name": "five", band: "5g" }] } },
    {
      radios: [
        { name: "radio1", type: "mac80211", path: "p1", band: "5g" },
        { name: "radio2", type: "mac80211", path: "p2", band: "5g" },
      ],
    }
  );
  const names = config.wireless["wifi-device"].map((d: any) => d[".name"]);
  t.is(new Set(names).size, 2, `names: ${names}`);
});

test('a wifi-iface on "*" (or no device) is fanned out to every radio, with its stations', (t) => {
  const config = build(
    {
      wireless: {
        "wifi-iface": [
          {
            ssid: "home",
            mode: "ap",
            network: "lan",
            stations: [{ key: "station-key-1" }],
          },
          { ssid: "iot", mode: "ap", network: "lan", device: "wifidevice0" },
        ],
      },
    },
    twoRadios
  );
  const ifaces = config.wireless["wifi-iface"];
  t.deepEqual(
    ifaces.map((i: any) => [i[".name"], i.device, i.ssid]),
    [
      ["wifinet00", "wifidevice0", "home"],
      ["wifinet01", "wifidevice1", "home"],
      ["wifinet10", "wifidevice0", "iot"],
    ]
  );
  t.deepEqual(
    config.wireless["wifi-station"].map((s: any) => s.iface),
    ["wifinet00", "wifinet01"]
  );
});

test("an interface on a radio for a band the device lacks is skipped", (t) => {
  const config = build(
    {
      wireless: {
        "wifi-device": [
          { ".name": "radio0", band: "2g" },
          { ".name": "radio1", band: "5g" },
          { ".name": "radio2", band: "6g" },
        ],
        "wifi-iface": [
          { ssid: "home", mode: "ap", network: "lan", device: ["radio0", "radio1"] },
          { ssid: "home", mode: "ap", network: "lan", device: ["radio2"] },
          { ssid: "typo", mode: "ap", network: "lan", device: ["radoi0"] },
        ],
      },
    },
    twoRadios
  );
  t.deepEqual(
    config.wireless["wifi-iface"].map((i: any) => [i.device, i.ssid]),
    [
      ["radio0", "home"],
      ["radio1", "home"],
      // radio2 (6 GHz) is declared, but this device has no 6 GHz radio.
      ["radoi0", "typo"],
    ],
    "a name nothing declares is kept, for netifd to report"
  );
});

test("the device's hostname is set in system", (t) => {
  const config = build({ system: { system: [{ timezone: "UTC0" }] } }, dsa);
  t.is(config.system.system[0].hostname, "box");
});

test('only one device per box may use "*" ports', (t) => {
  const bridges = (...names: string[]) => ({
    network: {
      device: names.map((name) => ({ name, type: "bridge", ports: "*" })),
    },
  });
  t.throws(() => build(bridges("br-lan", "br-guest"), dsa), {
    message:
      '"br-lan" and "br-guest" both use "ports": "*" on box, but a port can only be in one bridge. ' +
      "List the ports of all but one explicitly, or use one bridge with bridge-vlan sections.",
  });
  t.throws(() => build(bridges("a", "b", "c"), dsa), {
    message: /^"a", "b" and "c" all use/,
  });
  // Conditions are resolved first: two "*" bridges for different devices are fine.
  t.notThrows(() =>
    build(
      {
        network: {
          device: [
            {
              name: "br-lan",
              type: "bridge",
              ports: "*",
              ".if": "device.hostname == 'box'",
            },
            {
              name: "br-other",
              type: "bridge",
              ports: "*",
              ".if": "device.hostname == 'other'",
            },
          ],
        },
      },
      dsa
    )
  );
});

test('a VLAN on a port (a tagged internet line) keeps the port out of a "*" bridge', (t) => {
  const config = build(
    {
      network: {
        device: [{ name: "br-lan", type: "bridge", ports: "*" }],
        interface: [{ ".name": "wan", device: "@wan_port.10", proto: "dhcp" }],
      },
    },
    dsa
  );
  t.deepEqual(config.network.device[0].ports, ["eth1", "eth2"]);
});

test('"*" beside named ports: every free physical port, and the named ones (a mesh joining the bridge)', (t) => {
  const config = build(
    {
      network: {
        device: [{ name: "br-lan", type: "bridge", ports: ["*", "bat0"] }],
        "bridge-vlan": [
          { device: "br-lan", vlan: 1, ports: "*" },
          { device: "br-lan", vlan: 20, ports: "*t" },
        ],
        interface: [{ ".name": "wan", device: "@wan_port", proto: "dhcp" }],
      },
    },
    dsa
  );
  t.deepEqual(config.network.device[0].ports, ["eth1", "eth2", "bat0"]);
  t.deepEqual(config.network["bridge-vlan"][1].ports, ["eth1:t", "eth2:t", "bat0:t"]);
});

test('in a bridge VLAN\'s list, "*t" is the free physical ports alone, not the bridge\'s other members', (t) => {
  const config = build(
    {
      network: {
        device: [{ name: "br-lan", type: "bridge", ports: ["*", "bat0"] }],
        "bridge-vlan": [{ device: "br-lan", vlan: 4000, ports: ["*t"] }],
        interface: [{ ".name": "wan", device: "@wan_port", proto: "dhcp" }],
      },
    },
    dsa
  );
  t.deepEqual(config.network["bridge-vlan"][0].ports, ["eth1:t", "eth2:t"]);
});

test("swconfig: an untagged line never takes a VLAN another line has tagged; one VLAN on two ports is refused", (t) => {
  const config = build(
    {
      network: {
        interface: [
          { ".name": "wan", device: "@port:port1", proto: "dhcp" },
          { ".name": "wanb", device: "@port:port2.2", proto: "dhcp" },
        ],
      },
    },
    swconfig
  );
  const lines = config.network.switch_vlan.map((v: any) => [v.vlan, v.ports]);
  t.deepEqual(new Set(lines.map((l: any) => l[0])).size, lines.length, "every line its own VLAN");
  const wan = config.network.interface.find((i: any) => i[".name"] === "wan").device;
  const wanb = config.network.interface.find((i: any) => i[".name"] === "wanb").device;
  t.not(wan, wanb);
  t.is(wanb, "eth0.2");
  t.throws(
    () =>
      build(
        {
          network: {
            interface: [
              { ".name": "wan", device: "@port:port1.7", proto: "dhcp" },
              { ".name": "wanb", device: "@port:port2.7", proto: "dhcp" },
            ],
          },
        },
        swconfig
      ),
    { message: /VLAN 7 is on both port1 and port2/ }
  );
});

test("swconfig with the WAN on a NIC beside the switch: a line there is that NIC, out of every switch VLAN", (t) => {
  const board = (file: string) => JSON.parse(readFileSync(join(__dirname, "../helpers/boards", file), "utf8"));
  const c7 = parseDeviceFacts({ board: board("swconfig-wan-nic.board.json"), system: board("swconfig-wan-nic.system.json") });
  const config = build(
    {
      network: {
        switch_vlan: [
          { device: "switch0", vlan: 1, ports: "*" },
          { device: "switch0", vlan: 20, ports: "*t" },
        ],
        device: [{ name: "br-lan.1", type: "bridge", ports: ["@cpu_port.1"] }],
        interface: [
          { ".name": "wan", device: "@wan_port", proto: "dhcp" },
          { ".name": "wanb", device: "@port:port5.7", proto: "dhcp" },
        ],
      },
    },
    c7
  );
  const device = (name: string) => config.network.interface.find((i: any) => i[".name"] === name).device;
  t.is(device("wan"), "eth0");
  t.is(device("wanb"), "eth1.7", "a line on a switch port is still the CPU's VLAN");
  t.deepEqual(
    config.network.switch_vlan.map((v: any) => `${v.vlan}: ${v.ports}`),
    ["1: 0t 2 3 4", "20: 0t 2t 3t 4t", "7: 0t 5t"]
  );
  t.deepEqual(config.network.device[0].ports, ["eth1.1"]);
});

test("@cpu_port is expanded wherever it is a whole value, an interface's device included", (t) => {
  const config = build({ network: { interface: [{ ".name": "lan", device: "@cpu_port.3", proto: "none" }] } }, swconfig);
  t.is(config.network.interface[0].device, "eth0.3");
});

test('switch_vlan and bridge-vlan read "*t" the same alone or in a list; either without ports is refused', (t) => {
  const sw = build({ network: { switch_vlan: [{ device: "switch0", vlan: 2, ports: ["*t"] }] } }, swconfig);
  t.is(sw.network.switch_vlan[0].ports, "0t 1t 2t");
  t.throws(() => build({ network: { switch_vlan: [{ device: "switch0", vlan: 2 }] } }, swconfig), {
    message: /switch_vlan without ports/,
  });
  t.throws(
    () =>
      build(
        { network: { device: [{ name: "br-lan", type: "bridge", ports: "*" }], "bridge-vlan": [{ device: "br-lan", vlan: 1 }] } },
        dsa
      ),
    { message: /bridge-vlan without ports/ }
  );
});

const triBand = {
  radios: [
    { name: "radio0", type: "mac80211" as const, path: "p0", band: "2g" as const },
    { name: "radio1", type: "mac80211" as const, path: "p1", band: "5g" as const },
    { name: "radio2", type: "mac80211" as const, path: "p2", band: "5g" as const },
  ],
};

test("tri-band: an SSID on a band is on each of its radios; a pinned channel and an interface of its own name on the first only", (t) => {
  const config = build(
    {
      wireless: {
        "wifi-device": [
          { ".name": "radio2g", band: "2g" },
          { ".name": "radio5g", band: "5g", channel: 36 },
        ],
        "wifi-iface": [
          { ".name": "home", ssid: "home", mode: "ap", network: "lan", device: ["radio2g", "radio5g"] },
          { ".name": "mesh", mode: "mesh", ifname: "mesh0", network: "batmesh", device: ["radio5g"] },
        ],
      },
    },
    triBand
  );
  t.deepEqual(
    config.wireless["wifi-device"].map((d: any) => [d[".name"], d.channel]),
    [
      ["radio2g", 11],
      ["radio5g", 36],
      ["radio5g2", "auto"],
    ]
  );
  t.deepEqual(
    config.wireless["wifi-iface"].map((i: any) => [i[".name"], i.device]),
    [
      ["home_radio2g", "radio2g"],
      ["home_radio5g", "radio5g"],
      ["home_radio5g2", "radio5g2"],
      ["mesh_radio5g", "radio5g"],
    ]
  );
});

test("a radio nothing declares or uses is off; one an interface uses stays on", (t) => {
  const off = build({ wireless: { "wifi-device": [{ ".name": "radio2g", band: "2g" }] } }, twoRadios);
  t.deepEqual(
    off.wireless["wifi-device"].map((d: any) => [d.band, d.disabled]),
    [
      ["2g", undefined],
      ["5g", true],
    ]
  );
  const used = build({ wireless: { "wifi-iface": [{ ssid: "x", mode: "ap", network: "lan", device: "*" }] } }, twoRadios);
  t.true(used.wireless["wifi-device"].every((d: any) => d.disabled === undefined));
});
