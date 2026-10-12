import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { DeviceStatus } from "../../status/device";
import { activityOf, attentionOf, clientsOf, devicesOf } from "../../status/views";
import { parseSpeed } from "../../status/actions";
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

test("clients: one row per device, from leases, neighbours and Wi-Fi; our own devices left out", (t) => {
  const intent = sample();
  const router = device("home-router", {
    leases: [
      { mac: "aa:00:00:00:00:01", address: "10.0.0.23", name: "phone", expires: 1 },
      { mac: "aa:00:00:00:00:02", address: "10.0.0.24", name: "nas", expires: 1 },
      { mac: "aa:00:00:00:00:09", address: "10.0.0.50", name: "home-ap-1", expires: 1 },
    ],
    neighbours: [
      { address: "10.0.0.24", mac: "aa:00:00:00:00:02", state: "REACHABLE" },
      { address: "2001:db8::24", mac: "aa:00:00:00:00:02", state: "STALE" },
    ],
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
    { at: 1000, text: "daemon.notice netifd: Interface 'lan' is now up" },
    { at: 2000, text: "daemon.notice netifd: Network device 'eth1' link is down" },
    { at: 3000, text: "user.notice onc-ipv6: wan6 has an IPv6 default route, restarting odhcpd" },
    { at: 4000, text: "daemon.info dnsmasq[1]: read /etc/hosts" },
  ];
  t.deepEqual(activityOf(intent, [device("home-router", { log })]).map((e) => e.text), [
    "Wan6 has an IPv6 default route, restarting odhcpd",
    "Port eth1 disconnected",
    `${intent.networks[0].name} came up`,
  ]);
});

test("speed: bits over the router's uptime clock", (t) => {
  t.is(parseSpeed("0.65 25000000"), 307.7);
  t.is(parseSpeed("0 0"), undefined);
});
