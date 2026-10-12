import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { Intent, intentSchema } from "../../intent/schema";
import {
  DeviceStatus,
  parseInterfaces,
  parseLeases,
  parseLines,
  parseSystemInfo,
  parseWifi,
} from "../../status/device";
import { networkStatus } from "../../status/network";

const root = join(__dirname, "..", "..", "..");
const recorded = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "helpers", "status", name), "utf8"));
const sample = (): Intent =>
  intentSchema.parse(JSON.parse(readFileSync(join(root, "sampleConfigs", "intent.json"), "utf8")));

// As hostapd's ubus answers get_status and get_clients, assembled by the probe.
const hostapd = [
  {
    object: "hostapd.phy1-ap0",
    status: { status: "ENABLED", ssid: "Home", freq: 5180, channel: 36 },
    clients: {
      freq: 5180,
      clients: {
        "AA:BB:CC:00:00:01": { auth: true, assoc: true, signal: -58, bytes: { rx: 1000, tx: 2000 } },
        "aa:bb:cc:00:00:02": { auth: true, assoc: true, signal: -71 },
      },
    },
  },
  { object: "hostapd.phy0-ap1", status: { ssid: "Not Ours", freq: 2437, channel: 6 }, clients: { clients: {} } },
  { object: "hostapd.phy0-ap2", status: null, clients: null },
];

test("system info and interfaces, as OpenWrt 25.12 reports them", (t) => {
  const info = parseSystemInfo(recorded("system-info.json"));
  t.true(info.uptime > 0);
  t.true(info.load.every((l) => l >= 0 && l < 64), "ubus gives load ×65536");
  t.true(info.memory.available > 0 && info.memory.available <= info.memory.total);
  const interfaces = parseInterfaces(recorded("interface-dump.json"));
  t.deepEqual(interfaces.map((i) => i.id), ["lan"], "loopback left out");
  t.like(interfaces[0], { up: true, device: "br-lan", ipv4: ["192.168.1.1/24"] });
  t.true(interfaces[0].ipv6[0].startsWith("fd"), "its ULA, from the prefix assignment");
});

test("Wi-Fi clients per hostapd interface; leases; nothing breaks on missing fields", (t) => {
  const wifi = parseWifi(hostapd);
  t.deepEqual(wifi[0], {
    ifname: "phy1-ap0",
    ssid: "Home",
    freq: 5180,
    channel: 36,
    clients: [
      { mac: "aa:bb:cc:00:00:01", signal: -58, rxBytes: 1000, txBytes: 2000 },
      { mac: "aa:bb:cc:00:00:02", signal: -71 },
    ],
  });
  t.deepEqual(wifi[2], { ifname: "phy0-ap2", clients: [] });
  t.deepEqual(parseWifi(undefined), []);
  t.deepEqual(
    parseLeases("1791900000 AA:BB:CC:00:00:01 10.0.0.23 iphone 01:aa\n1791900001 aa:bb:cc:00:00:09 10.0.20.5 * *\n\n"),
    [
      { mac: "aa:bb:cc:00:00:01", address: "10.0.0.23", name: "iphone", expires: 1791900000 },
      { mac: "aa:bb:cc:00:00:09", address: "10.0.20.5", expires: 1791900001 },
    ]
  );
});

const device = (hostname: string, parts: Partial<DeviceStatus>): DeviceStatus => ({
  hostname,
  readAt: 0,
  uptime: 3600,
  load: [0.5, 0.4, 0.3],
  memory: { total: 1000, available: 600 },
  interfaces: [],
  wifi: [],
  leases: [],
  lines: [],
  ...parts,
});

test("interpreted against the settings: what matches, and what does not", (t) => {
  const intent = sample();
  const router = device("home-router", {
    interfaces: [
      { id: "lan", up: true, ipv4: ["10.0.0.1/24"], ipv6: [] },
      { id: "wan", up: true, uptime: 99, ipv4: ["203.0.113.5/24"], ipv6: [] },
      { id: "wan6", up: true, ipv4: [], ipv6: ["2001:db8::5/64"] },
      { id: "oldvpn", up: false, ipv4: [], ipv6: [] },
    ],
    leases: parseLeases("1 aa:bb:cc:00:00:01 10.0.0.23 phone *\n1 aa:bb:cc:00:00:09 10.0.20.5 * *"),
  });
  const ap = device("home-ap-1", { wifi: parseWifi(hostapd) });
  const status = networkStatus(intent, [router, ap]);
  t.deepEqual(status.internet, { up: true, ipv4: ["203.0.113.5/24"], ipv6: ["2001:db8::5/64"], uptime: 99 });
  t.deepEqual(
    status.networks.map((n) => [n.id, n.up, n.clients]),
    [
      ["lan", true, 1],
      ["guest", false, 1],
    ],
    "guest not up on the device: shown as it is, not assumed"
  );
  t.deepEqual(status.ssids[0], { ssid: "Home", accessPoints: ["home-ap-1"], clients: 2 });
  t.deepEqual(status.clients, { total: 3, wifi: 2 });
  t.deepEqual(status.unexpected, { interfaces: ["oldvpn"], ssids: ["Not Ours"] });
  t.like(status.devices[0], { name: "home-router", health: { uptime: 3600, load: 0.5, memoryUsed: 0.4 } });
});

test("a device not reached is said so; nothing is made up for it", (t) => {
  const status = networkStatus(sample(), [
    { hostname: "home-router", error: "connect ECONNREFUSED" },
    device("home-ap-1", {}),
  ]);
  t.is(status.internet, undefined);
  t.like(status.devices[0], { name: "home-router", error: "connect ECONNREFUSED" });
  t.is(status.networks[0].up, undefined);
});

test("several lines: mwan3's view of each, and which carry traffic", (t) => {
  // Recorded from mwan3 2.12 on 25.12.5, both lines failing to reach the internet.
  t.deepEqual(parseLines(recorded("mwan3-status.json")), [
    { id: "wan", state: "offline", since: 1 },
    { id: "wanb", state: "offline", since: 1 },
  ]);
  t.deepEqual(parseLines({}), [], "no mwan3: no lines");

  const intent = sample();
  intent.internet.connections.push({
    id: "wanb",
    name: "LTE",
    port: "eth2",
    connection: { type: "dhcp" },
    ipv6: false,
    ipv6_prefix: "auto",
    weight: 1,
    metered: true,
    down_when_slow: false,
  });
  const router = (wan: string, wanb: string) =>
    device("home-router", {
      lines: [
        { id: "wan", state: wan, since: 600 },
        { id: "wanb", state: wanb, since: 30 },
      ],
    });
  const using = (status: ReturnType<typeof networkStatus>) => status.connections.filter((c) => c.inUse).map((c) => c.id);
  t.deepEqual(using(networkStatus(intent, [router("online", "online")])), ["wan"], "failover: the first that works");
  const onBackup = networkStatus(intent, [router("offline", "online")]);
  t.deepEqual(using(onBackup), ["wanb"]);
  t.like(onBackup.connections[0], { line: { state: "offline", since: 600 }, inUse: false });
  t.true(onBackup.internet!.up);
  intent.internet.mode = "balance";
  t.deepEqual(using(networkStatus(intent, [router("online", "online")])), ["wan"], "sharing: a metered line held back");
  t.deepEqual(using(networkStatus(intent, [router("disconnecting", "online")])), ["wan"], "failing is still working");
});
