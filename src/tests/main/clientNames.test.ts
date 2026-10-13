// What clients call themselves over mDNS (the router's umdns, recorded on
// 25.12.5 with an announcing device beside it) and what they probably are.
import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { clientKind } from "../../status/clientKind";
import { parseMdns } from "../../status/device";
import { clientsOf } from "../../status/views";
import type { DeviceStatus } from "../../status/device";
import { ok } from "../../result";
import { sampleIntent } from "../helpers/fixtures";

const recorded = (name: string) => JSON.parse(readFileSync(join(__dirname, "../helpers/status", name), "utf8"));

test("umdns's cache read: each device by host, its own name, model, addresses and services", (t) => {
  const heard = parseMdns({ browse: recorded("umdns-browse.json"), hosts: recorded("umdns-hosts.json") });
  t.deepEqual(
    heard.find((d) => d.host === "jasons-iphone"),
    {
      host: "jasons-iphone",
      name: "Jason iPhone",
      addresses: ["192.168.215.17", "192.168.1.50"],
      model: "iPhone15,2",
      services: ["_companion-link._tcp", "_device-info._tcp"],
    }
  );
  t.like(heard.find((d) => d.host === "openwrt"), { name: "OpenWrt", services: ["_ssh._tcp"] });
  t.deepEqual(parseMdns({ browse: undefined, hosts: "not an object" }), [], "nothing readable: nothing heard");
});

test("a client's kind: its model first, then its services, its name, and a few makers", (t) => {
  t.is(clientKind({ mac: "02:00:00:00:00:01", model: "iPhone15,2", name: "kitchen" }), "phone");
  t.is(clientKind({ mac: "02:00:00:00:00:01", model: "AudioAccessory5,1" }), "speaker");
  t.is(clientKind({ mac: "02:00:00:00:00:01", services: ["_ipp._tcp"] }), "printer");
  t.is(clientKind({ mac: "02:00:00:00:00:01", name: "Jasons-MacBook-Pro" }), "laptop");
  t.is(clientKind({ mac: "b8:27:eb:12:34:56" }), "computer", "a Raspberry Pi's card");
  t.is(clientKind({ mac: "ba:27:eb:12:34:56" }), undefined, "a private address says nothing of its maker");
  t.is(clientKind({ mac: "00:11:22:33:44:55", name: "thing" }), undefined);
});

test("a client is named by what it calls itself over mDNS, unless you named it", (t) => {
  const intent = sampleIntent();
  const router = {
    hostname: "home-router",
    readAt: 0,
    uptime: 1,
    load: [0, 0, 0],
    memory: { total: 1, available: 1 },
    interfaces: [],
    wifi: [],
    leases: [
      { mac: "aa:00:00:00:00:01", address: "10.0.0.50", name: "Jasons-iPhone", expires: 0 },
      { mac: "aa:00:00:00:00:02", address: "10.0.0.51", expires: 0 },
    ],
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
    mdns: [
      { host: "jasons-iphone", name: "Jason iPhone", addresses: ["10.0.0.50"], model: "iPhone15,2", services: ["_device-info._tcp"] },
      { host: "living-room", name: "Living Room", addresses: ["10.0.0.51"], services: ["_googlecast._tcp"] },
    ],
  } as unknown as DeviceStatus;
  const clients = clientsOf(intent, [ok(router)], {});
  t.like(clients.find((c) => c.mac === "aa:00:00:00:00:01"), { name: "Jason iPhone", kind: "phone", model: "iPhone15,2" });
  t.like(clients.find((c) => c.mac === "aa:00:00:00:00:02"), { name: "Living Room", kind: "tv" });
});
