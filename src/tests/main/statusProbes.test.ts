// The status reader's newer probes, against output recorded on OpenWrt
// 25.12.5 in Docker (src/tests/helpers/status/; the public address replaced),
// or written to their documented layout where Docker has none (ports, adverts).
import test from "ava";
import { tempDir } from "../helpers/tempDir";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import type { Session } from "../../platform";
import { withEpochs } from "../helpers/logread";
import {
  parseAdverts,
  parseInternetCheck,
  parseIpv6Leases,
  parseLinks,
  parseLog,
  parseNeighbourTable,
  parsePingOutput,
  parseStorage,
  parseTemperature,
  pingNumbers,
  readDeviceStatus,
} from "../../status/device";
import { keptInRam } from "../../status/device/common";
import { parseSpeedTest, speedTestCommandFor } from "../../status/actions";

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

// Recorded by running the check's own command in OpenWrt 25.12.5's rootfs
// (busybox 1.37's ping and nslookup; no dnsmasq or https-dns-proxy there,
// so both fail); the public address replaced, the queue's line from an
// earlier recording on a router.
test("the router's checks: the internet's and the gateway's round trip, loss and jitter, the public address, DNS, each DoH instance, the queue's drops", (t) => {
  t.deepEqual(parseInternetCheck(recorded("internet-check.txt")), {
    // 17.675, 7.816, 18.361 and 6.275 ms: their mean, and how much each differs from the one before.
    latencyMs: 12.5,
    lossPercent: 0,
    jitterMs: 10.8,
    gateway: "192.168.215.1",
    gatewayMs: 0.1,
    gatewayLossPercent: 0,
    publicIpv4: "203.0.113.7",
    dnsOk: false,
    doh: [
      { port: 5053, ok: false },
      { port: 5054, ok: false },
    ],
    queues: [{ device: "eth0", sentBytes: 1974, dropped: 0 }],
  });
  t.deepEqual(parseInternetCheck("gateway \n== internet\n== gateway\n== end\nip \ndns ok"), { dnsOk: true, queues: [] }, "nothing pinged, nothing made up");
  const dead = "gateway 10.0.0.1\n== internet\nPING 1.1.1.1 (1.1.1.1): 56 data bytes\n\n--- 1.1.1.1 ping statistics ---\n4 packets transmitted, 0 packets received, 100% packet loss\n== gateway\n== end\ndns fail";
  t.like(parseInternetCheck(dead), { lossPercent: 100, gateway: "10.0.0.1", dnsOk: false });
  t.is(parseInternetCheck(dead).latencyMs, undefined, "no reply, no round trip");
  t.is(parseInternetCheck("gateway ;reboot\ndns ok").gateway, undefined, "only an address");
});

test("pings in numbers: the mean, the share lost, jitter between successive replies", (t) => {
  const ping = parsePingOutput("64 bytes from 1.1.1.1: seq=0 ttl=57 time=10.000 ms\n64 bytes from 1.1.1.1: seq=2 ttl=57 time=14.000 ms\n3 packets transmitted, 2 packets received, 33% packet loss");
  t.deepEqual(ping, { sent: 3, received: 2, times: [10, 14] });
  t.deepEqual(pingNumbers(ping), { ms: 12, lossPercent: 33, jitterMs: 4 });
  t.deepEqual(pingNumbers(undefined), {});
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

test("the log: each line's time, from its epoch (the date is the device's local time), and what it says", (t) => {
  const log = parseLog(withEpochs(recorded("logread.txt")));
  t.true(log.length > 5);
  t.regex(log[0].text, /netifd: Interface 'lan' is enabled/);
  t.is(log[0].at, Date.UTC(2026, 9, 12, 22, 4, 15));
  t.deepEqual(parseLog("Mon Oct 12 22:04:15 2026 [1791900000.250] daemon.notice x: y"), [{ at: 1791900000250, text: "x: y" }]);
  t.deepEqual(parseLog(recorded("logread.txt")), [], "only logread -t's lines: a date alone says no zone");
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
  // With the counts kept from a read two minutes before; a counter that went back (a restart) has none.
  t.deepEqual(parseAdverts("br-lan 3 90\nbr-lan.20 5 30\nbefore 130\nbr-lan 3 84\nbr-lan.20 120 30"), [
    { device: "br-lan", sent: 3, solicits: 90, before: { sent: 3, solicits: 84, seconds: 130 } },
    { device: "br-lan.20", sent: 5, solicits: 30 },
  ]);
  t.is(parseTemperature("48000\n61500\n"), 61.5);
  t.is(parseTemperature(""), undefined);
});

/** A session running the real batched probes in a local sh, with stub commands first on PATH. */
const stubbedSession = (stubs: Record<string, string>): Session => {
  const dir = tempDir("status");
  Object.entries(stubs).forEach(([name, body]) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  });
  return {
    execCommand: async (command) => {
      const r = spawnSync("sh", ["-c", command], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: "utf8" });
      return { stdout: r.stdout, stderr: r.stderr, code: r.status };
    },
    dispose: () => {},
  };
};

test("status: an answer that cannot be read is left out and named, not the whole device", async (t) => {
  const session = stubbedSession({
    ubus: `case "$1 $2 $3" in
  "call system info") echo '{"uptime":60,"load":[65536,0,0],"memory":{"total":1000,"available":500}}' ;;
  "call mwan3 status") echo '{not json' ;;
  *) exit 1 ;;
esac`,
    nlbw: "echo '{\"columns\": ['",
  });
  const status = await readDeviceStatus("ap", session, () => 0, [], { traffic: true });
  t.is(status.uptime, 60);
  t.deepEqual([...status.unread].sort(), ["mwan3", "traffic (nlbwmon)"]);
  t.deepEqual(status.lines, []);
  t.deepEqual(status.traffic, {});
});

test("status: a wedged ubus (system info says nothing) fails the read, not a device just booted", async (t) => {
  const session = stubbedSession({ ubus: "exit 7" });
  await t.throwsAsync(readDeviceStatus("ap", session, () => 0, ["dnsmasq"]), { message: /did not answer/ });
});

test("mDNS: one JSON answer, so a name holding anything (the old marker) cannot split it", async (t) => {
  const browse = { "_device-info._tcp": { "__ONC_HOSTS__ x": { host: "phone.local", ipv4: ["10.0.0.5"], txt: ["model=iPhone15,2"] } } };
  const session = stubbedSession({
    ubus: `case "$1 $2 $3" in
  "call system info") echo '{"uptime":60}' ;;
  "call umdns browse") echo '${JSON.stringify(browse)}' ;;
  "call umdns hosts") echo '{"phone.local":{"ipv4":["10.0.0.5"]}}' ;;
  *) exit 1 ;;
esac`,
  });
  const status = await readDeviceStatus("router", session, () => 0, [], { mdns: true });
  t.deepEqual(status.unread, []);
  t.deepEqual(status.mdns, [{ host: "phone", name: "__ONC_HOSTS__ x", addresses: ["10.0.0.5"], model: "iPhone15,2", services: ["_device-info._tcp"] }]);
});

test("the RAM dir: one planted (a symlink) is not used; a fresh one is, and removed after", (t) => {
  const planted = join(tempDir("planted"), "onc-status");
  symlinkSync(tempDir("elsewhere"), planted);
  const r = spawnSync("sh", ["-c", `( ${keptInRam.replace("/var/run/onc-status", planted)}; echo "$s"; touch "$s/x" )`], { encoding: "utf8" });
  const dir = r.stdout.trim();
  t.truthy(dir);
  t.not(dir, planted);
  t.false(existsSync(dir), "nothing left behind");
});

test("speed test: a slow line is measured by what came in its window, and nothing is left running on the device", (t) => {
  const bin = tempDir("speed");
  // A line giving 100 kB a second and taking no upload; pings that answer at once, or until stopped.
  writeFileSync(join(bin, "uclient-fetch"), '#!/bin/sh\ncase "$*" in *post-file*) exec sleep 100;; esac\nwhile :; do head -c 100000 /dev/zero; sleep 1; done\n', { mode: 0o755 });
  writeFileSync(join(bin, "ping"), '#!/bin/sh\nsay() { echo "64 bytes from 1.1.1.1: seq=0 ttl=58 time=10.000 ms"; echo "1 packets transmitted, 1 packets received, 0% packet loss"; }\ncase "$*" in *"-c 3"*) say; exit 0;; esac\ntrap \'say; exit 0\' INT\nsleep 100 & wait\n', { mode: 0o755 });
  const meminfo = join(bin, "meminfo");
  writeFileSync(meminfo, "MemAvailable: 999999 kB\n");
  // The uptime clock as whole seconds, a 1 s window and a 1 s grace, so the test is quick.
  const command = speedTestCommandFor(1, 1).replace(/cut -d' ' -f1 \/proc\/uptime/g, "date +%s").replace("/proc/meminfo", meminfo);
  const r = spawnSync("sh", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 15_000 });
  const result = parseSpeedTest(r.stdout, 0);
  // Stopped at the window and its grace, 2 s: what came in by then, about 0.8 Mbit/s.
  t.true(result.downMbps! > 0.3 && result.downMbps! < 1.5, r.stdout);
  t.is(result.upMbps, undefined, "no upload ever finished");
  t.is(result.idleMs, 10);
  t.is(spawnSync("pgrep", ["-f", `${bin}/uclient-fetch`]).status, 1, "every transfer killed");
});
