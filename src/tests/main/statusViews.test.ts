import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { DeviceStatus, parseHeardBy, parseTraffic } from "../../status/device";
import { activityOf, attentionOf, clientsOf, devicesOf, internetCountersOf, keepActivity, restartable } from "../../status/views";
import { compileIntent } from "../../intent/compile";
import { neighboursOf, parseSpeed, parseSurvey } from "../../status/actions";
import { intentSchema } from "../../intent/schema";

const sample = () =>
  intentSchema.parse(JSON.parse(readFileSync(join(__dirname, "../../../sampleConfigs/intent.json"), "utf8")));

const device = (hostname: string, parts: Partial<DeviceStatus>): DeviceStatus => ({
  hostname,
  readAt: 0,
  uptime: 3600,
  load: [0.2, 0.2, 0.2],
  memory: { total: 1000, available: 600 },
  interfaces: [],
  wifi: [],
  leases: [],
  lines: [],
  mesh: [],
  wireguard: [],
  links: [],
  adverts: [],
  neighbours: [],
  ipv6Leases: [],
  notRunning: [],
  unread: [],
  counters: {},
  traffic: {},
  heardBy: [],
  ...parts,
});

const lanUp = [{ id: "lan", up: true, device: "br-lan", ipv4: [], ipv6: [] }, { id: "wan", up: true, ipv4: [], ipv6: [] }];

test("needs attention: the router silent on IPv6 (solicits heard, no adverts) is a problem, with its fix", (t) => {
  const intent = sample();
  intent.internet.connections[0].ipv6 = true;
  const router = device("home-router", { interfaces: lanUp, adverts: [{ device: "br-lan", sent: 0, solicits: 84 }] });
  const found = attentionOf({ intent, devices: [router, device("home-ap-1", {})], facts: {} });
  t.like(found[0], { id: "ipv6:silent", severity: "problem", fix: { device: "home-router", service: "odhcpd" } });
  const healthy = device("home-router", { interfaces: lanUp, adverts: [{ device: "br-lan", sent: 120, solicits: 84 }] });
  t.false(attentionOf({ intent, devices: [healthy, device("home-ap-1", {})], facts: {} }).some((a) => a.id === "ipv6:silent"));
  const silentOf = (adverts: DeviceStatus["adverts"], i = intent) =>
    attentionOf({ intent: i, devices: [device("home-router", { interfaces: lanUp, adverts }), device("home-ap-1", {})], facts: {} }).some(
      (a) => a.id === "ipv6:silent"
    );
  // Over the last few minutes: asked and not answered is silent; answered since (fixed) is not, however it was before.
  t.true(silentOf([{ device: "br-lan", sent: 40, solicits: 90, before: { sent: 40, solicits: 84, seconds: 130 } }]));
  t.false(silentOf([{ device: "br-lan", sent: 2, solicits: 90, before: { sent: 0, solicits: 84, seconds: 130 } }]));
  // A network the compiler gives no IPv6 (kept to another line) is never silent.
  const offMain = structuredClone(intent);
  offMain.internet.connections.push({ ...offMain.internet.connections[0], id: "wanb", name: "Backup" });
  offMain.networks[0] = { ...offMain.networks[0], line: { connection: "wanb", fallback: true } } as never;
  t.false(silentOf([{ device: "br-lan", sent: 0, solicits: 84 }], offMain));
});

test("needs attention: an unreachable device, a stopped service with its fix, an SSID not on the air, no internet", (t) => {
  const intent = sample();
  const router = device("home-router", {
    interfaces: [{ id: "lan", up: true, ipv4: [], ipv6: [] }, { id: "wan", up: false, ipv4: [], ipv6: [] }],
    notRunning: [{ name: "dnsmasq", missing: false }],
  });
  const ids = attentionOf({ intent, devices: [router, device("home-ap-1", { wifi: [] })], facts: {}, applied: "differs" }).map((a) => a.id);
  t.true(ids.includes("internet:down"));
  t.true(ids.includes("service:home-router:dnsmasq"));
  t.true(ids.some((id) => id.startsWith("ssid:home-ap-1:")));
  t.is(ids[ids.length - 1], "apply:pending", "information last");
  t.true(attentionOf({ intent, devices: [{ hostname: "home-router", error: "timed out" }], facts: {} }).some((a) => a.id === "unreachable:home-router"));
});

test("needs attention: no restart offered for what the link depends on, or for a service declared off; unread parts said", (t) => {
  const intent = sample();
  const router = device("home-router", {
    interfaces: [{ id: "wan", up: true, ipv4: [], ipv6: [] }],
    notRunning: [{ name: "dropbear", missing: false }],
    unread: ["mwan3"],
  });
  const items = attentionOf({ intent, devices: [router], facts: {} });
  t.is(items.find((a) => a.id === "service:home-router:dropbear")?.fix, undefined);
  t.true(items.some((a) => a.id === "unread:home-router" && a.detail.startsWith("mwan3")));
  t.true(restartable({ name: "odhcpd", running: true }));
  t.false(restartable({ name: "mwan3", running: true, enabled: false }));
  t.false(restartable({ name: "https-dns-proxy" }));
  t.false(restartable({ name: "network", running: true }));
});

test("clients: one row per device, from leases, neighbours and Wi-Fi; our own devices left out", (t) => {
  const intent = sample();
  const router = device("home-router", {
    leases: [
      { mac: "aa:00:00:00:00:01", address: "10.0.0.23", name: "phone", expires: 1 },
      { mac: "aa:00:00:00:00:02", address: "10.0.0.24", name: "nas", expires: 1 },
      { mac: "aa:00:00:00:00:09", address: "10.0.0.50", name: "home-ap-1", expires: 1 },
    ],
    neighbours: [
      { address: "10.0.0.24", mac: "aa:00:00:00:00:02", state: "REACHABLE", device: "br-lan" },
      { address: "2001:db8::24", mac: "aa:00:00:00:00:02", state: "STALE", device: "br-lan" },
      // The provider's modem, seen on the internet line: not a client.
      { address: "192.168.178.1", mac: "aa:00:00:00:00:77", state: "REACHABLE", device: "eth1" },
    ],
    interfaces: [{ id: "wan", up: true, ipv4: [], ipv6: [], device: "eth1" }],
  });
  const ap = device("home-ap-1", { wifi: [{ ifname: "phy1-ap0", ssid: "Home", freq: 5180, clients: [{ mac: "aa:00:00:00:00:01", signal: -58 }] }] });
  const clients = clientsOf(intent, [router, ap], { "home-ap-1": { hostname: "home-ap-1", readAt: 0, schema: { name: "x", version: "25.12.5" }, macs: ["aa:00:00:00:00:09"] } });
  t.deepEqual(clients.map((c) => c.name), ["nas", "phone"]);
  t.like(clients.find((c) => c.name === "phone"), { state: "online", connection: { kind: "wifi", accessPoint: "home-ap-1", ssid: "Home", band: "5 GHz", signal: -58 } });
  t.like(clients.find((c) => c.name === "nas"), { state: "online", connection: { kind: "wired" }, ipv6: ["2001:db8::24"] });
});

test("devices: each one's ports from its facts, with their links", (t) => {
  const intent = sample();
  const facts = {
    "home-router": { hostname: "home-router", readAt: 0, schema: { name: "r", version: "25.12.5", ports: [{ name: "eth0" }, { name: "eth1", default_role: "wan" as const }] } },
  };
  const [router] = devicesOf(intent, [device("home-router", { links: [{ name: "eth0", up: true, speed: 1000 }, { name: "phy0-ap0", up: true }] })], facts);
  t.deepEqual(router.ports, [{ name: "eth0", up: true, speed: 1000 }, { name: "eth1", up: false }]);
});

test("activity: log lines in words, newest first; the rest left out", (t) => {
  const intent = sample();
  const log = [
    // As parseLog leaves them: the tag first.
    { at: 1000, text: "netifd: Interface 'lan' is now up" },
    { at: 2000, text: "netifd: Network device 'eth1' link is down" },
    { at: 3000, text: "onc-ipv6: wan6 has an IPv6 default route, restarting odhcpd" },
    { at: 4000, text: "dnsmasq[1]: read /etc/hosts" },
    { at: 5000, text: "mwan3track[2211]: Interface wan (eth1) is offline" },
    // A client's name in someone else's line is not this app speaking.
    { at: 6000, text: "dnsmasq-dhcp[1]: DHCPACK(br-lan) 10.0.0.9 aa:bb onc-ipv6: all clear" },
  ];
  t.deepEqual(activityOf(intent, [device("home-router", { log })]).map(({ text, kind }) => [text, kind]), [
    [`${intent.internet.connections[0].name} is offline`, "down"],
    ["Wan6 has an IPv6 default route, restarting odhcpd", "note"],
    ["Port eth1 disconnected", "down"],
    [`${intent.networks[0].name} came up`, "up"],
  ]);
});

test("speed: bits over the router's uptime clock", (t) => {
  t.is(parseSpeed("0.65 25000000"), 307.7);
  t.is(parseSpeed("0 0"), undefined);
});

test("survey: our own radios left out by BSSID, on any access point; another radio with our name is an impostor", (t) => {
  const scan = (results: unknown[]) => ({ results });
  const ap1 = parseSurvey("ap-1", [
    {
      ifname: "phy1-ap0",
      bssid: "02:00:00:00:00:01",
      scan: scan([
        { ssid: "Home", bssid: "02:00:00:00:00:02", channel: 36, signal: -50 },
        { ssid: "Home", bssid: "66:00:00:00:00:09", channel: 36, signal: -70 },
        { ssid: "Cafe", bssid: "66:00:00:00:00:08", channel: 1, signal: -80, mhz: 5975 },
      ]),
      survey: { results: [{ mhz: 5180, active_time: 100, busy_time: 40, in_use: true }] },
    },
  ]);
  const ap2 = parseSurvey("ap-2", [{ ifname: "phy1-ap0", bssid: "02:00:00:00:00:02", scan: null, survey: null }]);
  const [one] = neighboursOf([ap1, ap2], ["Home"], true);
  t.deepEqual(one.neighbours, [
    { ssid: "Home", channel: 36, signal: -70, band: "5 GHz", impostor: true },
    { ssid: "Cafe", channel: 1, signal: -80, band: "6 GHz" },
  ]);
  t.deepEqual(one.channels, [{ band: "5 GHz", channel: 36, busy: 40, ours: true }]);
  // ap-2 not surveyed: its radios are unknown, so our names are left out rather than called impostors.
  t.deepEqual(neighboursOf([ap1], ["Home"], false)[0].neighbours.map((n) => n.ssid), ["Cafe"]);
});

test("needs attention: an SSID is missed only where the access point has a radio in one of its bands", (t) => {
  const intent = sample();
  intent.wifi = [{ ...intent.wifi[0], ssid: "Fast", bands: ["5g"] }];
  const facts = (band: "2g" | "5g") => ({
    "home-ap-1": { hostname: "home-ap-1", readAt: 0, schema: { name: "ap", version: "25.12.5", radios: [{ name: "radio0", type: "mac80211" as const, band }] } },
  });
  const missed = (band: "2g" | "5g") =>
    attentionOf({ intent, devices: [device("home-ap-1", { wifi: [] })], facts: facts(band) as never }).some((a) => a.id === "ssid:home-ap-1:Fast");
  t.false(missed("2g"));
  t.true(missed("5g"));
});

test("traffic and roaming: nlbwmon's table by its columns, usteer's clients by node", (t) => {
  // nlbw -c json -g mac, and ubus call usteer get_clients, in their documented layouts.
  t.deepEqual(
    parseTraffic({
      columns: ["mac", "conns", "rx_bytes", "rx_pkts", "tx_bytes", "tx_pkts"],
      data: [["AA:00:00:00:00:01", 12, 5000, 10, 700, 8], ["bad"]],
    }),
    { "aa:00:00:00:00:01": { rx: 5000, tx: 700 } }
  );
  t.deepEqual(parseTraffic(undefined), {});
  t.deepEqual(
    parseHeardBy({
      "AA:00:00:00:00:01": { "hostapd.phy1-ap0": { connected: true, signal: -58 }, "10.0.0.3#hostapd.phy1-ap0": { connected: false, signal: -71 } },
    }),
    [
      { mac: "aa:00:00:00:00:01", node: "hostapd.phy1-ap0", signal: -58, connected: true },
      { mac: "aa:00:00:00:00:01", node: "10.0.0.3#hostapd.phy1-ap0", signal: -71, connected: false },
    ]
  );
});

test("clients: the router's traffic count over its access point's, each saying what it covers; roaming from each AP's own node", (t) => {
  const intent = sample();
  const router = device("home-router", {
    leases: [{ mac: "aa:00:00:00:00:01", address: "10.0.0.23", name: "phone", expires: 1 }],
    traffic: { "aa:00:00:00:00:01": { rx: 900, tx: 100 } },
  });
  const ap = device("home-ap-1", {
    wifi: [{ ifname: "phy1-ap0", ssid: "Home", freq: 5180, clients: [{ mac: "aa:00:00:00:00:01", signal: -58, rxBytes: 1, txBytes: 2 }] }],
    heardBy: [
      { mac: "aa:00:00:00:00:01", node: "hostapd.phy1-ap0", signal: -58, connected: true },
      { mac: "aa:00:00:00:00:01", node: "10.0.0.3#hostapd.phy1-ap0", signal: -71, connected: false },
    ],
  });
  const [phone] = clientsOf(intent, [router, ap], {});
  t.deepEqual(phone.traffic, { down: 900, up: 100, over: "month" });
  t.deepEqual(phone.heardBy, [{ accessPoint: "home-ap-1", band: "5 GHz", signal: -58, connected: true }]);
  const [alone] = clientsOf(intent, [device("home-router", { leases: router.leases }), ap], {});
  t.deepEqual(alone.traffic, { down: 2, up: 1, over: "connection" }, "the access point's: what it sent is what the client downloaded");
});

test("throughput counters: each line's own, by its device on the router", (t) => {
  const intent = sample();
  const router = device("home-router", {
    readAt: 5000,
    interfaces: [{ id: "wan", up: true, device: "eth1", ipv4: [], ipv6: [] }],
    counters: { eth1: { rx: 10, tx: 20 }, "br-lan": { rx: 99, tx: 99 } },
  });
  t.deepEqual(internetCountersOf(intent, [router]), { lines: { wan: { rx: 10, tx: 20 } }, at: 5000 });
  t.is(internetCountersOf(intent, [{ hostname: "home-router", error: "x" }]), undefined);
});

test("activity kept: newest first, the same event read twice kept once, bounded", (t) => {
  const e = (at: number, text: string) => ({ at, device: "r", text });
  t.deepEqual(keepActivity([e(1000, "a"), e(500, "b")], [e(1500, "a"), e(3000, "c")]), [e(3000, "c"), e(1500, "a"), e(500, "b")]);
  t.is(keepActivity([], Array.from({ length: 20 }, (_, i) => e(i * 5000, `x${i}`)), 5).length, 5);
});

test("traffic: nlbwmon on the router only, running, its database in RAM", (t) => {
  const compiled = compileIntent(sample()) as any;
  const profile = compiled.package_profiles.find((p: any) => p.packages.includes("nlbwmon"));
  t.regex(profile[".if"], /router/);
  const section = compiled.config.nlbwmon.nlbwmon[0];
  t.regex(section[".if"], /router/);
  t.true(section.database_directory.startsWith("/var/"));
});
