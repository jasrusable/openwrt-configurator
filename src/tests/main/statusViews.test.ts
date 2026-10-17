import test from "ava";
import { reads } from "../helpers/reads";
import { sampleIntent } from "../helpers/fixtures";
import { DeviceStatus, parseHeardBy, parseTraffic } from "../../status/device";
import { attentionOf, clientsOf, devicesOf, internetCountersOf, logWords, restartable } from "../../status/views";
import { printPlan } from "../../lowLevel/print";
import { compileIntent } from "../../intent/compile";
import { bloatGrade, neighboursOf, parseSpeed, parseSpeedTest, parseSurvey } from "../../status/actions";
import { readFileSync } from "fs";
import { join } from "path";

const sample = () =>
  sampleIntent();

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
  mdns: [],
  ...parts,
});

const lanUp = [{ id: "lan", up: true, device: "br-lan", ipv4: [], ipv6: [] }, { id: "wan", up: true, ipv4: [], ipv6: [] }];

test("needs attention: the router silent on IPv6 (solicits heard, no adverts) is a problem, with its fix", (t) => {
  const intent = sample();
  intent.internet.lines[0].ipv6.enabled = true;
  const router = device("home-router", { interfaces: lanUp, adverts: [{ device: "br-lan", sent: 0, solicits: 84 }] });
  const found = attentionOf({ intent, devices: reads(router, device("home-ap-1", {})), facts: {} });
  t.like(found[0], { id: "ipv6:silent", severity: "problem", fix: { device: "home-router", service: "odhcpd" } });
  const healthy = device("home-router", { interfaces: lanUp, adverts: [{ device: "br-lan", sent: 120, solicits: 84 }] });
  t.false(attentionOf({ intent, devices: reads(healthy, device("home-ap-1", {})), facts: {} }).some((a) => a.id === "ipv6:silent"));
  const silentOf = (adverts: DeviceStatus["adverts"], i = intent) =>
    attentionOf({ intent: i, devices: reads(device("home-router", { interfaces: lanUp, adverts }), device("home-ap-1", {})), facts: {} }).some(
      (a) => a.id === "ipv6:silent"
    );
  // Over the last few minutes: asked and not answered is silent; answered since (fixed) is not, however it was before.
  t.true(silentOf([{ device: "br-lan", sent: 40, solicits: 90, before: { sent: 40, solicits: 84, seconds: 130 } }]));
  t.false(silentOf([{ device: "br-lan", sent: 2, solicits: 90, before: { sent: 0, solicits: 84, seconds: 130 } }]));
  // A network the compiler gives no IPv6 (kept to another line) is never silent.
  const offMain = structuredClone(intent);
  offMain.internet.lines.push({ ...offMain.internet.lines[0], id: "wanb", name: "Backup" });
  offMain.networks[0] = { ...offMain.networks[0], access: { ...offMain.networks[0].access, via: "wanb", fallback: true } };
  t.false(silentOf([{ device: "br-lan", sent: 0, solicits: 84 }], offMain));
});

test("needs attention: an unreachable device, a stopped service with its fix, an SSID not on the air, no internet", (t) => {
  const intent = sample();
  const router = device("home-router", {
    interfaces: [{ id: "lan", up: true, ipv4: [], ipv6: [] }, { id: "wan", up: false, ipv4: [], ipv6: [] }],
    notRunning: [{ name: "dnsmasq", missing: false }],
  });
  const ids = attentionOf({ intent, devices: reads(router, device("home-ap-1", { wifi: [] })), facts: {}, applied: "differs" }).map((a) => a.id);
  t.true(ids.includes("internet:down"));
  t.true(ids.includes("service:home-router:dnsmasq"));
  t.true(ids.some((id) => id.startsWith("ssid:home-ap-1:")));
  t.is(ids[ids.length - 1], "apply:pending", "information last");
  t.true(attentionOf({ intent, devices: reads({ hostname: "home-router", error: "timed out" }), facts: {} }).some((a) => a.id === "unreachable:home-router"));
});

test("needs attention: no restart offered for what the link depends on, or for a service declared off; unread parts said", (t) => {
  const intent = sample();
  const router = device("home-router", {
    interfaces: [{ id: "wan", up: true, ipv4: [], ipv6: [] }],
    notRunning: [{ name: "dropbear", missing: false }],
    unread: ["mwan3"],
  });
  const items = attentionOf({ intent, devices: reads(router), facts: {} });
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
  const clients = clientsOf(intent, reads(router, ap), { "home-ap-1": { hostname: "home-ap-1", readAt: 0, schema: { name: "x", version: "25.12.5" }, macs: ["aa:00:00:00:00:09"] } });
  t.deepEqual(clients.map((c) => c.name), ["nas", "phone"]);
  t.like(clients.find((c) => c.name === "phone"), { state: "online", connection: { kind: "wifi", accessPoint: "home-ap-1", ssid: "Home", band: "5 GHz", signal: -58 } });
  t.like(clients.find((c) => c.name === "nas"), { state: "online", connection: { kind: "wired" }, ipv6: ["2001:db8::24"] });
});

test("devices: each one's ports from its facts, with their links", (t) => {
  const intent = sample();
  const facts = {
    "home-router": { hostname: "home-router", readAt: 0, schema: { name: "r", version: "25.12.5", ports: [{ name: "eth0" }, { name: "eth1", default_role: "wan" as const }] } },
  };
  const [router] = devicesOf(intent, reads(device("home-router", { links: [{ name: "eth0", up: true, speed: 1000 }, { name: "phy0-ap0", up: true }] })), facts);
  t.deepEqual(router.ports, [{ name: "eth0", up: true, speed: 1000 }, { name: "eth1", up: false }]);
});

test("a device's log in words: links, interfaces, mwan3 and this app's marks; the rest left as logged", (t) => {
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
  t.deepEqual(log.map(({ text }) => logWords(intent, text)).map((w) => w && [w.text, w.tone]), [
    [`${intent.networks[0].name} came up`, "up"],
    ["Port eth1 disconnected", "down"],
    ["Wan6 has an IPv6 default route, restarting odhcpd", "note"],
    undefined,
    [`${intent.internet.lines[0].name} is offline`, "down"],
    undefined,
  ]);
  const [router] = devicesOf(intent, reads(device("home-router", { log })), {});
  t.deepEqual(router.log?.[0], { at: 1000, text: "netifd: Interface 'lan' is now up", said: `${intent.networks[0].name} came up`, tone: "up" });
  t.deepEqual(router.log?.[3], { at: 4000, text: "dnsmasq[1]: read /etc/hosts" }, "as logged, nothing said of it");
});

test("speed: bits over the router's uptime clock", (t) => {
  t.is(parseSpeed("0.65 25000000"), 307.7);
  t.is(parseSpeed("0 0"), undefined);
});

// Recorded by running the test's own command in OpenWrt 25.12.5's rootfs,
// over this machine's line: eight seconds each way, pings throughout.
test("speed test: down and up, the round trip at rest and under load, and bufferbloat's grade", (t) => {
  const result = parseSpeedTest(readFileSync(join(__dirname, "../helpers/status/speed-test.txt"), "utf8"), 1000);
  t.deepEqual(result, { at: 1000, downMbps: 471.9, upMbps: 87.5, idleMs: 6.2, downLoadedMs: 14, upLoadedMs: 14.4 });
  t.deepEqual(bloatGrade(result), { addedMs: 8, grade: "B" });
  t.deepEqual(parseSpeedTest("down 0 0\n== idle\n== end", 5), { at: 5 }, "nothing came: nothing said");
  t.deepEqual(bloatGrade({ idleMs: 10, downLoadedMs: 12 }), { addedMs: 2, grade: "A" });
  t.deepEqual(bloatGrade({ idleMs: 10, downLoadedMs: 50, upLoadedMs: 300 }), { addedMs: 290, grade: "F" }, "the worse direction");
  t.is(bloatGrade({ downLoadedMs: 50 }), undefined, "no round trip at rest to compare with");
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
  intent.wifi.networks = [{ ...intent.wifi.networks[0], ssid: "Fast", bands: ["5g"] }];
  const facts = (band: "2g" | "5g") => ({
    "home-ap-1": { hostname: "home-ap-1", readAt: 0, schema: { name: "ap", version: "25.12.5", radios: [{ name: "radio0", type: "mac80211" as const, band }] } },
  });
  const missed = (band: "2g" | "5g") =>
    attentionOf({ intent, devices: reads(device("home-ap-1", { wifi: [] })), facts: facts(band) as never }).some((a) => a.id === "ssid:home-ap-1:Fast");
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
  const [phone] = clientsOf(intent, reads(router, ap), {});
  t.deepEqual(phone.traffic, { down: 900, up: 100, over: "month" });
  t.deepEqual(phone.heardBy, [{ accessPoint: "home-ap-1", band: "5 GHz", signal: -58, connected: true }]);
  const [alone] = clientsOf(intent, reads(device("home-router", { leases: router.leases }), ap), {});
  t.deepEqual(alone.traffic, { down: 2, up: 1, over: "connection" }, "the access point's: what it sent is what the client downloaded");
});

test("throughput counters: each line's own, by its device on the router", (t) => {
  const intent = sample();
  const router = device("home-router", {
    readAt: 5000,
    interfaces: [{ id: "wan", up: true, device: "eth1", ipv4: [], ipv6: [] }],
    counters: { eth1: { rx: 10, tx: 20 }, "br-lan": { rx: 99, tx: 99 } },
  });
  t.deepEqual(internetCountersOf(intent, reads(router)), { lines: { wan: { rx: 10, tx: 20 } }, at: 5000 });
  t.is(internetCountersOf(intent, reads({ hostname: "home-router", error: "x" })), undefined);
});

test("traffic: nlbwmon on the router only, running, its database in RAM", (t) => {
  const compiled = printPlan(compileIntent(sample())) as any;
  const profile = compiled.package_profiles.find((p: any) => p.packages.includes("nlbwmon"));
  t.regex(profile[".if"], /router/);
  const section = compiled.config.nlbwmon.nlbwmon[0];
  t.regex(section[".if"], /router/);
  t.true(section.database_directory.startsWith("/var/"));
});
