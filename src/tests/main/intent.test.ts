import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtConfig } from "../../getOpenWrtConfig";
import { compileIntent } from "../../intent/compile";
import { ulaPrefix } from "../../intent/features/network";
import { migrateIntent } from "../../intent/migrations";
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
  // Every LAN port a trunk: the main network untagged, guests tagged.
  t.deepEqual(
    config.network["bridge-vlan"].map((v: any) => [v.vlan, v.ports]),
    [
      [1, ["eth0", "eth2"]],
      [20, ["eth0:t", "eth2:t"]],
    ]
  );
  t.deepEqual(config.dhcp.dnsmasq[0].server, ["127.0.0.1#5053"]);
  t.is(wan.peerdns, false, "encrypted DNS ignores the ISP's resolvers");
  t.is(config.system.system[0].timezone, "CET-1CEST,M3.5.0,M10.5.0/3");
  t.false("wireless" in config, "the router has no radios and no Wi-Fi");
});

test("on the router: each network routed, served and firewalled by purpose", (t) => {
  const config = onDevice("home-router", "friendlyarm,nanopi-r6s");
  const iface = (name: string) =>
    config.network.interface.find((i: any) => i[".name"] === name);
  t.like(iface("lan"), { device: "br-lan.1", proto: "static", ipaddr: "10.0.0.1" });
  t.like(iface("guest"), { device: "br-lan.20", proto: "static", ipaddr: "10.0.20.1" });
  t.is(iface("guest").ip6assign, undefined, "IPv6 is off on the guest network");
  t.deepEqual(
    config.dhcp.dhcp.map((d: any) => [d.interface, d.start, d.limit]),
    [
      ["lan", 5, 250],
      ["guest", 155, 100],
    ]
  );
  t.deepEqual(config.dhcp.dnsmasq[0].interface, ["lan", "guest"]);
  // Home reaches everything; guests only the internet and the router's
  // DHCP and DNS.
  t.deepEqual(
    config.firewall.forwarding.map((f: any) => `${f.src}->${f.dest}`),
    ["lan->wan", "lan->guest", "guest->wan"]
  );
  const zone = (name: string) => config.firewall.zone.find((z: any) => z.name === name);
  t.is(zone("lan").input, "ACCEPT");
  t.is(zone("guest").input, "REJECT");
  t.deepEqual(
    config.firewall.rule.filter((r: any) => r.src === "guest").map((r: any) => r.name),
    [
      "Allow-guest-DHCP",
      "Allow-guest-DHCPv6",
      "Allow-guest-DNS",
      "Allow-guest-NTP",
      "Allow-guest-ICMPv6",
      "Guests may print",
    ]
  );
  t.like(
    config.firewall.rule.find((r: any) => r.name === "Guests may print"),
    { src: "guest", dest: "lan", dest_ip: ["10.0.0.20"], proto: ["tcp"], dest_port: "631 9100", target: "ACCEPT" }
  );
  // The stock WAN rules are on unless switched off.
  t.true(config.firewall.rule.some((r: any) => r.name === "Allow-Ping"));
  // A port forward lands in the zone of the network its target is on.
  t.like(config.firewall.redirect[0], {
    name: "Game server",
    target: "DNAT",
    src: "wan",
    src_dport: "27015",
    proto: ["udp"],
    dest: "lan",
    dest_ip: "10.0.0.50",
    dest_port: "27015",
  });
});

test("rules compile one to one, in order; WAN is a zone with masquerading", (t) => {
  const intent = sample();
  // Stock rules are ordinary rules: removing one removes it.
  intent.firewall.rules = intent.firewall.rules.filter((r: any) => r.name !== "Allow-Ping");
  intent.firewall.rules.push({
    name: "Block IoT",
    from: "guest",
    to: "wan",
    protocols: ["all"],
    family: "any",
    enabled: true,
    action: "drop",
  });
  const fw = (compile(intent).config as any).firewall;
  const names = fw.rule.map((r: any) => r.name);
  t.false(names.includes("Allow-Ping"));
  t.is(names[0], "Allow-DHCP-Renew", "in the order given");
  t.deepEqual(fw.rule.find((r: any) => r.name === "Block IoT").proto, ["all"]);
  t.like(fw.rule.find((r: any) => r.name === "Allow-ICMPv6-Forward"), { src: "wan", dest: "*" });
  t.is(fw.rule.find((r: any) => r.name === "Allow-DHCP-Renew").dest, undefined, "to the device: input");
  t.like(fw.zone.find((z: any) => z.name === "wan"), {
    masq: true,
    mtu_fix: true,
    network: ["wan", "wan6"],
  });
});

test("on the access point: bridged, a DHCP client, Wi-Fi on both bands", (t) => {
  const config = onDevice("home-ap-1", "zyxel,nwa50ax-pro");
  const iface = (name: string) =>
    config.network.interface.find((i: any) => i[".name"] === name);
  t.is(iface("lan").proto, "dhcp", "a client of the main network");
  t.like(iface("guest"), { device: "br-lan.20", proto: "none" }, "guests only bridged");
  t.deepEqual(
    config.wireless["wifi-device"].map((r: any) => [r.band, r.channel]),
    [
      ["2g", 11],
      ["5g", 36],
    ]
  );
  t.deepEqual(
    config.wireless["wifi-iface"].map((w: any) => [w.ssid, w.network, w.isolate]),
    [
      ["Home", "lan", undefined],
      ["Home", "lan", undefined],
      ["Home Guests", "guest", true],
      ["Home Guests", "guest", true],
    ],
    "each Wi-Fi on both bands, on its network; guests isolated"
  );
  t.true(
    Object.values(config.firewall ?? {}).every((s: any) => s.length === 0),
    "no firewall sections"
  );
  t.is(config.ubihealthd["ubi-device"][0].device, "/dev/ubi0");
});

test("radios are set per band; an SSID can keep to some bands; 6 GHz is WPA3", (t) => {
  const intent = sample();
  intent.radios = {
    "2g": { enabled: true, width: "auto", power: "low", cell_density: "off" },
    "5g": { enabled: true, width: "160", power: "auto", cell_density: "high" },
    "6g": { enabled: true },
  };
  intent.wifi[1].bands = ["2g"];
  const config = compile(intent).config.wireless as any;
  const radio = (band: string) => config["wifi-device"].find((d: any) => d.band === band);
  t.like(radio("2g"), { htmode: "HE20", txpower: 10, cell_density: 0 });
  t.like(radio("5g"), { htmode: "HE160", cell_density: 2 });
  t.is(radio("5g").txpower, undefined, "auto: as much as the country allows");
  t.is(radio("6g").disabled, undefined);
  t.deepEqual(
    config["wifi-iface"].map((w: any) => [w.ssid, w.device, w.encryption]),
    [
      ["Home", ["radio0", "radio1"], "psk2+ccmp"],
      ["Home", ["radio2"], "sae"],
      ["Home Guests", ["radio0"], "psk2+ccmp"],
    ]
  );
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

test("rules across settings are checked, at the field they concern", (t) => {
  const issues = (change: (intent: any) => void) => {
    const intent = sample();
    change(intent);
    const result = intentSchema.safeParse(intent);
    return result.success
      ? []
      : result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
  };
  t.deepEqual(issues(() => {}), []);
  t.deepEqual(issues((i) => (i.networks[1].vlan = undefined)), [
    "networks: exactly one network must be the main, untagged one",
  ]);
  t.deepEqual(issues((i) => (i.networks[1].subnet = "10.0.0.0/24")), [
    "networks.1.subnet: already used by another network",
  ]);
  t.deepEqual(issues((i) => (i.wifi[1].network = "gone")), [
    "wifi.1.network: pick a network",
  ]);
  t.deepEqual(issues((i) => (i.networks[1].vlan = 1)), [
    "networks.1.vlan: 2 to 4094 (1 is the main network)",
  ]);
  t.deepEqual(issues((i) => (i.firewall.zones[1].networks = [])), [
    "networks.1.id: not in any firewall zone",
  ]);
  t.deepEqual(issues((i) => i.firewall.forwardings.push({ from: "guest", to: "nowhere" })), [
    "firewall.forwardings.3.to: pick a zone",
  ]);
  t.deepEqual(
    issues((i) => (i.firewall.port_forwards[0].internal_address = "192.168.9.9")),
    ["firewall.port_forwards.0.internal_address: not on any of your networks"]
  );
  t.deepEqual(
    issues((i) =>
      i.firewall.port_forwards.push({ ...i.firewall.port_forwards[0], name: "Again", protocol: "tcp+udp" })
    ),
    ["firewall.port_forwards.1.external_port: already forwarded"]
  );
});

test("a version 1 file is migrated, keeping every setting", (t) => {
  const v1 = {
    schema: 1,
    site: { name: "Home", timezone: "Europe/Zurich", country: "CH" },
    devices: [{ name: "r", role: "router" }],
    internet: { connection: { type: "dhcp" } },
    network: {
      subnet: "10.0.0.0/24",
      domain: "home",
      dhcp: { size: 200, lease: "24h" },
      ipv6: false,
    },
    wifi: [{ ssid: "Home", password: "password1" }],
    dns: { over_https: "quad9" },
  };
  const migrated = intentSchema.parse(migrateIntent(v1));
  t.is(migrated.schema, 5);
  t.deepEqual(migrated.networks, [
    {
      id: "lan",
      name: "Home",
      purpose: "home",
      subnet: "10.0.0.0/24",
      dhcp: { size: 200, lease: "24h" },
      ipv6: false,
    },
  ]);
  // Format 2's access became the firewall: a trusted zone that reaches WAN,
  // WAN a zone of its own, and the stock rules as ordinary rules.
  t.like(migrated.firewall.zones[0], { id: "lan", networks: ["lan"], input: "accept" });
  t.like(migrated.firewall.zones[1], { id: "wan", masquerade: true, mss_clamping: true });
  t.deepEqual(migrated.firewall.forwardings, [{ from: "lan", to: "wan" }]);
  t.is(migrated.firewall.rules.length, 9);
  t.is(migrated.wifi[0].network, "lan");
  t.deepEqual(migrated.dns, { over_https: "quad9", local_domain: "home" });
  t.throws(() => migrateIntent({ ...v1, schema: 99 }), { message: /newer/ });
});

test("the ULA prefix is stable and well-formed", (t) => {
  t.is(ulaPrefix("Home"), ulaPrefix("Home"));
  t.not(ulaPrefix("Home"), ulaPrefix("Cabin"));
  t.regex(ulaPrefix("Home"), /^fd[0-9a-f]{2}:[0-9a-f]{4}:[0-9a-f]{4}::\/48$/);
});
