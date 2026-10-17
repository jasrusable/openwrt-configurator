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
  parseStorage,
  parseTemperature,
  readDeviceStatus,
} from "../../status/device";
import { keptInRam } from "../../status/device/common";
import { speedCommand, speedSeconds } from "../../status/actions";

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

test("speed test: a slow line is measured by what came in its time, and the download ends on the device", (t) => {
  const bin = tempDir("speed");
  writeFileSync(join(bin, "uclient-fetch"), "#!/bin/sh\nwhile :; do head -c 1000 /dev/zero; sleep 1; done\n", { mode: 0o755 });
  // The uptime clock as whole seconds, and a 2 s limit, so the test is quick.
  const command = speedCommand.replace(/cut -d' ' -f1 \/proc\/uptime/g, "date +%s").replace(`-lt ${speedSeconds}`, "-lt 2");
  const r = spawnSync("sh", ["-c", command], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 10_000 });
  const [seconds, bytes] = r.stdout.trim().split(/\s+/).map(Number);
  t.true(seconds >= 1 && seconds <= 3, r.stdout);
  t.true(bytes >= 1000 && bytes <= 3000, r.stdout);
  t.is(spawnSync("pgrep", ["-f", `${bin}/uclient-fetch`]).status, 1, "killed");
});
