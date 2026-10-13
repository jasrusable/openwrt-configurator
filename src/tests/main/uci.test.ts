import test from "ava";
import { keepsOf } from "../helpers/fixtures";
import { keepText } from "../../plan/types";
import {
  changedConfigs,
  declaredConfigs,
  parseUciExport,
  unmatchedKeeps,
  verifyConfigs,
  wipeOperations,
} from "../../engine/uci";

// Real `uci export` output (25.12.5), plus the probe's marker for a config uci
// could not parse.
const exported = `package firewall

config defaults
	option input 'REJECT'

config rule
	option name 'Allow-Ping'
	list proto 'icmp'

config rule
	option name 'it'\\''s'
	option note 'x
config fake'

package qosify

config defaults
	list defaults '/etc/qosify/*.conf'

package network

config interface 'lan'
	option proto 'static'
	list dns '1.1.1.1'
	list dns '9.9.9.9'

package empty

__ONC_UNREADABLE__ broken
`;

test("parses uci export: anonymous sections, lists, escapes, multi-line values", (t) => {
  const { configs, unreadable } = parseUciExport(exported);
  t.deepEqual(configs.firewall, [
    { type: "defaults", options: { input: "REJECT" } },
    { type: "rule", options: { name: "Allow-Ping", proto: ["icmp"] } },
    // The quoted newline is part of the value, not a new section.
    { type: "rule", options: { name: "it's", note: "x\nconfig fake" } },
  ]);
  // A type shared by two configs belongs to each.
  t.deepEqual(configs.qosify, [
    { type: "defaults", options: { defaults: ["/etc/qosify/*.conf"] } },
  ]);
  t.deepEqual(configs.network, [
    {
      type: "interface",
      name: "lan",
      options: { proto: "static", dns: ["1.1.1.1", "9.9.9.9"] },
    },
  ]);
  t.deepEqual(configs.empty, []);
  t.deepEqual(unreadable, ["broken"]);
});

test("parsing never echoes a value in its errors", (t) => {
  t.throws(() => parseUciExport("package x\nconfig a\n\toption k 'hunter2"), {
    message: /ends inside a quoted value/,
  });
  const error = t.throws(() => parseUciExport("garbage hunter2\n"));
  t.false(error!.message.includes("hunter2"));
});

test("the wipe deletes every section not kept, by exact name", (t) => {
  const { configs } = parseUciExport(exported);
  t.deepEqual(wipeOperations(configs, keepsOf("qosify.*", "firewall.defaults")), [
    "delete firewall.@rule[0]",
    "delete firewall.@rule[0]",
    "delete network.lan",
  ]);
  t.deepEqual(wipeOperations(configs, []).slice(0, 3), [
    "delete firewall.@defaults[0]",
    "delete firewall.@rule[0]",
    "delete firewall.@rule[0]",
  ]);
});

test("named sections go before anonymous ones of the same type", (t) => {
  // @rule[0] counts named sections too, so deleting those first leaves only
  // anonymous ones for it to reach.
  const configs = {
    firewall: [
      { type: "rule", options: {} },
      { type: "rule", name: "named", options: {} },
    ],
  };
  t.deepEqual(wipeOperations(configs, []), [
    "delete firewall.named",
    "delete firewall.@rule[0]",
  ]);
});

test("declared values read back the way uci stores them", (t) => {
  t.deepEqual(
    declaredConfigs({
      network: {
        interface: [
          {
            ".name": "lan",
            enabled: true,
            mtu: 1500,
            dns: ["1.1.1.1"],
            ip6assign: "",
            ports: [],
          },
        ],
      },
    } as any),
    {
      network: [
        {
          type: "interface",
          name: "lan",
          options: { enabled: "1", mtu: "1500", dns: ["1.1.1.1"] },
        },
      ],
    }
  );
});

test("commits every config the wipe or the declared config changes", (t) => {
  const current = {
    firewall: [{ type: "rule", options: {} }],
    luci: [{ type: "core", name: "main", options: {} }],
    dhcp: [{ type: "dnsmasq", options: {} }],
  };
  const declared = {
    network: [{ type: "interface", name: "lan", options: {} }],
    usteer: [],
  };
  t.deepEqual(
    changedConfigs({ current, declared, keep: keepsOf("luci.*", "dhcp.dnsmasq") }),
    ["firewall", "network"]
  );
});

const section = (
  type: string,
  name: string | undefined,
  options: Record<string, string | string[]> = {}
) => ({ type, ...(name !== undefined ? { name } : {}), options });

test("verification passes when the staged config is exactly the declared one", (t) => {
  const declared = {
    network: [
      section("interface", "lan", { proto: "static", dns: ["a", "b"] }),
    ],
  };
  t.deepEqual(
    verifyConfigs({
      actual: {
        network: [
          section("globals", "globals", { ula_prefix: "x" }),
          section("interface", "lan", { proto: "static", dns: ["a", "b"] }),
        ],
        luci: [section("core", "main")],
      },
      declared,
      keep: keepsOf("network.globals", "luci.*"),
    }),
    []
  );
});

test("verification catches leftovers, order, values and option kinds, without values", (t) => {
  const declared = {
    network: [section("interface", "lan", { key: "hunter2", dns: ["a"] })],
    firewall: [section("rule", "r1"), section("rule", "r2")],
  };
  const problems = verifyConfigs({
    actual: {
      network: [
        section("interface", "lan", { key: "other", dns: "a", extra: "1" }),
      ],
      firewall: [section("rule", "r2"), section("rule", "r1")],
      sqm: [section("queue", "eth1")],
    },
    declared,
    keep: [],
  });
  t.deepEqual(problems, [
    "firewall: expected sections [r1=rule, r2=rule], found [r2=rule, r1=rule]",
    "network.lan: option key differs",
    // A one-item list is not an option, though `uci show` prints them alike.
    "network.lan: option dns differs",
    "network.lan: unexpected option extra",
    "sqm: expected sections [], found [eth1=queue]",
  ]);
  t.false(problems.join("\n").includes("hunter2"));
});

test("a declared section of a kept type only needs its declared options", (t) => {
  const declared = {
    network: [section("globals", "globals", { packet_steering: "1" })],
  };
  const keep = keepsOf("network.globals");
  t.deepEqual(
    verifyConfigs({
      actual: {
        network: [
          section("globals", "globals", { packet_steering: "1", ula: "x" }),
        ],
      },
      declared,
      keep,
    }),
    []
  );
  t.deepEqual(
    verifyConfigs({ actual: { network: [] }, declared, keep }),
    ["network.globals: section is missing"]
  );
});

test("a declared config the device does not have is a problem", (t) => {
  t.deepEqual(
    verifyConfigs({
      actual: {},
      declared: { sqm: [section("queue", "q")] },
      keep: [],
    }),
    ["sqm: config does not exist on the device"]
  );
});

test("keep entries naming no config on the device are reported", (t) => {
  t.deepEqual(
    unmatchedKeeps(keepsOf("dropbaer.*", "luci.*", "system.led"), {
      luci: [],
      system: [],
    }).map(keepText),
    ["dropbaer.*"]
  );
});

test("an optional keep (?config.*) keeps a config if present and is never reported missing", (t) => {
  const { configs } = parseUciExport("package ubihealthd\n\nconfig ubi-device 'ubi0'\n\toption device '/dev/ubi0'\n");
  t.deepEqual(wipeOperations(configs, keepsOf("?ubihealthd.*")), []);
  t.true(wipeOperations(configs, []).length > 0, "without the keep it would be wiped");
  t.deepEqual(unmatchedKeeps(keepsOf("?ubihealthd.*", "typo.*"), {}).map(keepText), ["typo.*"]);
});

test("a section name uci refuses (a hyphen) stops the run before anything is sent", (t) => {
  const { getUciCommands } = require("../../engine/getUciCommands");
  const config = (name: string) => ({ network: { interface: [{ ".name": name, proto: "none" }] } });
  t.throws(() => getUciCommands({ openWrtConfig: config("my-lan") }), { message: /section name "my-lan"/ });
  t.notThrows(() => getUciCommands({ openWrtConfig: config("my_lan") }));
});

test("an unset value is no option at all, never the text undefined: a radio mode no width fits", (t) => {
  const { getUciCommands } = require("../../engine/getUciCommands");
  const { getOpenWrtConfig } = require("../../engine/getOpenWrtConfig");
  const { planOf } = require("../helpers/fixtures");
  const plan = planOf({
    devices: [{ hostname: "ap", tags: {} }],
    config: { wireless: { "wifi-device": [{ ".name": "radio0", band: "5g", htmode: "@best/20" }] } },
  });
  const openWrtConfig = getOpenWrtConfig({
    plan,
    deviceConfig: plan.devices[0],
    deviceSchema: { name: "x", version: "25.12.5", ports: [], radios: [{ name: "radio0", type: "mac80211", path: "p", band: "5g", htmodes: [] }] },
  });
  const commands: string[] = getUciCommands({ openWrtConfig });
  t.true(commands.includes("uci set wireless.radio0=wifi-device"));
  t.false(commands.some((c) => /undefined|null|htmode/.test(c)), commands.join("\n"));
});
