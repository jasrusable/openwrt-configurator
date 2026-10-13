// The hand-written low-level format, read strictly and printed back as the
// same plan: its few dot-keys and nothing else, placeholders only where they
// mean something (and text that looks like one kept text), and what a
// section cannot do without checked once it is fitted to a device.
import test from "ava";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtConfig } from "../../engine/getOpenWrtConfig";
import { planOfJson } from "../../loadConfig";
import { printPlan } from "../../lowLevel/print";
import { readText, writeText } from "../../lowLevel/placeholders";
import { planIssues } from "../../plan/check";
import { placeholder, section } from "../../plan/types";
import { planOf } from "../helpers/fixtures";

const device = { hostname: "box", tags: {} };
const schema = deviceSchemaSchema.parse({
  name: "test,device",
  version: "25.12.5",
  sw_config: false,
  ports: [
    { name: "eth0", default_role: "wan" },
    { name: "eth1", default_role: "lan" },
  ],
});
const config = (sections: object) => ({ devices: [device], config: sections });
const message = (json: unknown) => {
  const read = planOfJson(json);
  return read.ok ? "" : read.error.message;
};
const fitted = (sections: object) => getOpenWrtConfig({ plan: planOf(config(sections)), deviceConfig: device, deviceSchema: schema });

test("a section's keys that start with a dot are its name, condition and overrides: any other is refused, not dropped", (t) => {
  t.regex(message(config({ system: { system: [{ ".comment": "hello", hostname: "x" }] } })), /unknown key \.comment/);
  t.regex(message(config({ system: { system: [{ ".overrides": [{ ".if": "*", override: { ".if": "*" } }] }] } })), /unknown key \.if/);
});

test("an override may rename its section, and the device gets that name", (t) => {
  const out = fitted({
    system: { system: [{ ".name": "s", ".overrides": [{ ".if": "device.hostname == 'box'", override: { ".name": "renamed", zonename: "UTC" } }] }] },
  });
  t.deepEqual(out.system.system.map((s) => s[".name"]), ["renamed"]);
});

test("text that reads like a placeholder stays text, there and back", (t) => {
  for (const [at, text] of [
    ["wireless.wifi-iface.ssid", "@wan_port"],
    ["wireless.wifi-iface.ssid", "@@already doubled"],
    ["wireless.wifi-iface.ssid", "*"],
    ["system.system.description", "@best/80"],
  ] as const) {
    const written = writeText(at, text, true);
    t.is(readText(at, written, true), text, `${at}: ${text} written as ${written}`);
  }
  t.is(readText("network.device.ports", "*", false).constructor, Object, "in a port list, * is the free ports");
  t.throws(() => writeText("network.device.ports", "*", false), { message: /reads as a placeholder/ }, "no port is named *");
});

test("a placeholder where it means nothing is refused, by the plan check and when printing", (t) => {
  const plan = {
    devices: [device],
    packages: [],
    services: [],
    files: [],
    keep: [],
    config: { network: { "bridge-vlan": [section({}, { device: "br-lan", vlan: 1, ports: [placeholder.bridgePorts] })] } },
  };
  t.regex(planIssues(plan).map((i) => i.message).join(), /bridgePorts placeholder cannot stand in network\.bridge-vlan\.ports/);
  t.throws(() => printPlan(plan), { message: /bridgePorts placeholder cannot stand in network\.bridge-vlan\.ports/ });
});

test("what a section cannot do without is checked once fitted: a zone's policies, an interface's protocol, a forwarding's options", (t) => {
  t.throws(() => fitted({ network: { interface: [{ ".name": "lan", device: "eth1" }] } }), { message: /network\.interface needs proto/ });
  t.throws(() => fitted({ firewall: { zone: [{ ".name": "lan", name: "lan", network: ["lan"] }] } }), { message: /firewall\.zone needs input/ });
  t.throws(() => fitted({ firewall: { forwarding: [{ src: "lan", dst: "wan" }] } }), { message: /firewall\.forwarding has no option dst/ });
  t.throws(() => fitted({ network: { device: [{ name: "br-lan", mtu: 1500.5 }] } }), { message: /network\.device\.0\.mtu: Expected integer/ }, "caught as the config is read");
  t.notThrows(() => fitted({ firewall: { forwarding: [{ src: "lan", dest: "wan" }] } }));
});
