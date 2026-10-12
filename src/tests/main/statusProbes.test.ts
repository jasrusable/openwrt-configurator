// The status reader's newer probes, against output recorded on OpenWrt
// 25.12.5 in Docker (src/tests/helpers/status/; the public address replaced),
// or written to their documented layout where Docker has none (ports, adverts).
import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import {
  parseAdverts,
  parseInternetCheck,
  parseIpv6Leases,
  parseLinks,
  parseLog,
  parseNeighbourTable,
  parseStorage,
  parseTemperature,
} from "../../status/device";

const recorded = (name: string) => readFileSync(join(__dirname, "../helpers/status", name), "utf8");

test("storage: the overlay's total and free space", (t) => {
  t.deepEqual(parseStorage(recorded("df.txt")), { totalKb: 122814464, availableKb: 103346396 });
  t.is(parseStorage(""), undefined);
});

test("neighbours: each address with its MAC and state; one that failed has none and is left out", (t) => {
  const table = parseNeighbourTable(recorded("ip-neigh.txt"));
  t.is(table.length, 2);
  t.like(table[0], { address: "192.168.215.2", state: "REACHABLE" });
  t.deepEqual(parseNeighbourTable("fe80::1 dev br-lan lladdr AA:BB:CC:DD:EE:01 router STALE"), [
    { address: "fe80::1", mac: "aa:bb:cc:dd:ee:01", state: "STALE", device: "br-lan" },
  ]);
});

test("the Internet view's checks: latency, the public address, DNS, the queue's drops", (t) => {
  t.deepEqual(parseInternetCheck(recorded("internet-check.txt")), {
    latencyMs: 8.806,
    publicIpv4: "203.0.113.7",
    dnsOk: true,
    queues: [{ device: "eth0", sentBytes: 1974, dropped: 0 }],
  });
  t.deepEqual(parseInternetCheck("ping \nip \ndns fail"), { dnsOk: false, queues: [] });
});

test("IPv6 leases: the MAC inside a DUID (LL and LLT), the hostname and addresses", (t) => {
  t.deepEqual(parseIpv6Leases(JSON.parse(recorded("ipv6leases.json"))), []);
  const leases = parseIpv6Leases({
    device: {
      "br-lan": {
        leases: [
          { duid: "00030001aabbccddee01", hostname: "laptop", "ipv6-addr": [{ address: "2001:db8::10" }] },
          { duid: "000100012e5e1b54aabbccddee02", "ipv6-addr": [] },
          { duid: "0004c0ffee", "ipv6-addr": [{ address: "2001:db8::11" }] },
        ],
      },
    },
  });
  t.deepEqual(leases, [
    { duid: "00030001aabbccddee01", mac: "aa:bb:cc:dd:ee:01", hostname: "laptop", addresses: ["2001:db8::10"] },
    { duid: "000100012e5e1b54aabbccddee02", mac: "aa:bb:cc:dd:ee:02", addresses: [] },
    { duid: "0004c0ffee", addresses: ["2001:db8::11"] },
  ]);
});

test("the log: each line's time and what it says", (t) => {
  const log = parseLog(recorded("logread.txt"));
  t.true(log.length > 5);
  t.regex(log[0].text, /netifd: Interface 'lan' is enabled/);
  t.true(Number.isFinite(log[0].at));
});

test("ports, adverts and temperature, as the kernel prints them", (t) => {
  t.deepEqual(parseLinks("eth0 1 1000\neth1 0 -1\nphy0-ap0 1 -1"), [
    { name: "eth0", up: true, speed: 1000 },
    { name: "eth1", up: false },
    { name: "phy0-ap0", up: true },
  ]);
  t.deepEqual(parseAdverts("br-lan 0 84\nbr-lan.20 120 30"), [
    { device: "br-lan", sent: 0, solicits: 84 },
    { device: "br-lan.20", sent: 120, solicits: 30 },
  ]);
  t.is(parseTemperature("48000\n61500\n"), 61.5);
  t.is(parseTemperature(""), undefined);
});
