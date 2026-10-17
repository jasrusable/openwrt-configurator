// The graphs' rules, which are pure: a rate only between reads close
// together, a minute's mean, what is new merged over what is held; and
// every setting on a page.
import test from "ava";
import { fields } from "../../intent/fields";
import {
  airtimeOf,
  bucketMs,
  clientRange,
  clientReadingsOf,
  historyOfClient,
  historySince,
  keepMs,
  mergeHistory,
  radioKey,
  ranges,
  rate,
  readingsOf,
  throughputOf,
  withClientReadings,
  withReadings,
  withReadingsEverywhere,
  withSample,
} from "../../status/history";
import type { NetworkStatus } from "../../status/network";
import type { ClientView } from "../../status/views";
import { whereIs } from "../../../ui/src/settingPages";

const at = (seconds: number) => seconds * 1000;

test("a rate is bits per second between two counts", (t) => {
  t.is(rate({ v: 1000, at: at(0) }, { v: 2000, at: at(10) }), 800);
});

test("no rate from counts too far apart, gone backwards, out of order or alone", (t) => {
  t.is(rate({ v: 0, at: at(0) }, { v: 1000, at: at(121) }), undefined);
  t.is(rate({ v: 2000, at: at(0) }, { v: 1000, at: at(10) }), undefined);
  t.is(rate({ v: 0, at: at(10) }, { v: 1000, at: at(10) }), undefined);
  t.is(rate(undefined, { v: 1000, at: at(10) }), undefined);
});

test("throughput is each line's rate from its own last count, summed", (t) => {
  const first = throughputOf({ at: at(0), lines: { wan: { rx: 0, tx: 0 } } }, {});
  t.is(first.down, undefined, "one count says nothing yet");
  const second = throughputOf({ at: at(10), lines: { wan: { rx: 1000, tx: 500 }, wanb: { rx: 9e9, tx: 9e9 } } }, first.counts);
  t.is(second.down, 800, "a line just come up counts from its next read");
  t.is(second.up, 400);
});

test("reads in one minute are one point, their mean; a day is kept", (t) => {
  const start = 100 * bucketMs;
  let h = withSample({}, "latency", start + at(5), 10);
  h = withSample(h, "latency", start + at(15), 20);
  h = withSample(h, "latency", start + bucketMs, 40);
  t.deepEqual(h.latency, [[start, 15, 2], [start + bucketMs, 40, 1]]);
  t.deepEqual(withSample(h, "latency", start + keepMs + at(30), 1).latency.map((p) => p[0]), [start + bucketMs, start + keepMs], "the first minute is past a day");
  t.deepEqual(historySince(h, start + bucketMs + at(30)), { latency: [[start + bucketMs, 40, 1]] }, "the minute still filling comes again");
});

test("a device gone from the settings keeps no history", (t) => {
  const h = withReadings({ "load:old": [[0, 1, 1]], down: [[0, 1, 1]] }, bucketMs, { "load:ap": 0.5 }, ["ap"]);
  t.deepEqual(Object.keys(h).sort(), ["down", "load:ap"]);
});

test("what is new replaces the minutes it repeats", (t) => {
  const now = 10 * bucketMs;
  const kept = { down: [[8 * bucketMs, 1, 1], [9 * bucketMs, 2, 1]] as [number, number, number][] };
  const merged = mergeHistory(kept, { down: [[9 * bucketMs, 3, 2], [10 * bucketMs, 4, 1]], up: [[10 * bucketMs, 5, 1]] }, now);
  t.deepEqual(merged.down, [[8 * bucketMs, 1, 1], [9 * bucketMs, 3, 2], [10 * bucketMs, 4, 1]]);
  t.deepEqual(merged.up, [[10 * bucketMs, 5, 1]]);
});

test("every labelled setting is on a page", (t) => {
  const lost = fields.map((f) => f.path).filter((path) => !whereIs(path));
  t.deepEqual(lost, []);
});

test("a list item's setting leads to that item's page", (t) => {
  t.deepEqual(whereIs("internet.lines.1.shaping.down_mbps"), { page: "internet", url: "/settings/internet/1" });
  t.deepEqual(whereIs("wifi.radios.5g.width"), { page: "wifi", url: "/settings/wifi/radios/5g" });
  t.deepEqual(whereIs("vpn.remote_access.clients.0.name"), { page: "vpn", url: "/settings/vpn/0" });
  t.deepEqual(whereIs("dns.upstream"), { page: "dns", url: "/settings/dns" });
  t.deepEqual(whereIs("system.patches"), { page: "system", url: "/settings/system/patches" });
  t.deepEqual(whereIs("system.patches.off.0"), { page: "system", url: "/settings/system/patches" });
  t.is(whereIs("nowhere.at.all"), undefined);
});

test("30 days at 15 minutes: reads fold into quarter hours, and a month is kept", (t) => {
  const quarter = ranges.month.bucketMs;
  const start = 1000 * quarter;
  let h = withSample({}, "clients", start + at(60), 4, ranges.month);
  h = withSample(h, "clients", start + at(600), 6, ranges.month);
  h = withSample(h, "clients", start + quarter + at(1), 10, ranges.month);
  t.deepEqual(h.clients, [[start, 5, 2], [start + quarter, 10, 1]]);
  const later = withSample(h, "clients", start + ranges.month.keepMs + at(1), 1, ranges.month);
  t.deepEqual(later.clients.map((p) => p[0]), [start + quarter, start + ranges.month.keepMs], "the first quarter hour is past 30 days");
  const both = withReadingsEverywhere({ day: {}, month: {} }, start + at(30), { clients: 3 }, []);
  t.deepEqual([both.day.clients, both.month.clients], [[[start, 3, 1]], [[start, 3, 1]]], "each read goes into both ranges");
});

const network = (over: Partial<NetworkStatus> = {}): NetworkStatus => ({
  connections: [],
  devices: [],
  networks: [],
  ssids: [],
  clients: { total: 0, wifi: 0 },
  unexpected: { interfaces: [], ssids: [] },
  ...over,
});

test("one read's numbers: latency, loss and jitter, each line up (1) or down (0), each device's load, memory and temperature, each radio's clients and busy", (t) => {
  const readings = readingsOf(
    network({
      internet: { up: true, ipv4: [], ipv6: [] },
      connections: [
        { id: "wan", name: "Fibre", up: true, ipv4: [], ipv6: [], line: { state: "online", since: 5 } },
        { id: "wanb", name: "LTE", up: true, ipv4: [], ipv6: [], line: { state: "offline", since: 5 } },
      ],
      internetCheck: { latencyMs: 12, lossPercent: 25, jitterMs: 3, gateway: "10.0.0.1", gatewayMs: 1, dnsOk: true, queues: [] },
      deviceViews: [{ name: "loft", role: "access-point", reachable: true, load: 1, cores: 2, memoryUsed: 0.4, temperature: 60, ports: [] }],
      radios: [
        { accessPoint: "loft", ifname: "phy1-ap0", band: "5 GHz", clients: 3, busy: 40 },
        { accessPoint: "loft", ifname: "phy1-ap1", band: "5 GHz", clients: 2, busy: 42 },
        { accessPoint: "loft", ifname: "phy0-ap0", band: "2.4 GHz", clients: 1 },
      ],
    }),
    { down: 8e6 }
  );
  t.deepEqual(readings, {
    down: 8e6,
    latency: 12,
    gateway: 1,
    loss: 25,
    jitter: 3,
    internet: 1,
    "line:wan": 1,
    "line:wanb": 0,
    "load:loft": 0.5,
    "memory:loft": 0.4,
    "temperature:loft": 60,
    [radioKey("clients", "loft", "5 GHz")]: 5,
    [radioKey("busy", "loft", "5 GHz")]: 42,
    [radioKey("clients", "loft", "2.4 GHz")]: 1,
  });
  t.deepEqual(readingsOf(network({ connections: [{ id: "wan", name: "Fibre", ipv4: [], ipv6: [] }] }), {}), {}, "the router not read: a gap, not a line down");
});

test("a device gone from the settings keeps no history of its own: load, memory, temperature, radios", (t) => {
  const h = withReadings(
    { "memory:old": [[0, 1, 1]], [radioKey("busy", "old", "5 GHz")]: [[0, 1, 1]], "line:wan": [[0, 1, 1]], latency: [[0, 1, 1]] },
    bucketMs,
    {},
    ["ap"]
  );
  t.deepEqual(Object.keys(h).sort(), ["latency", "line:wan"]);
});

test("each radio's channel: how busy since the last read, from running totals, wrapped ones too; nothing from one read", (t) => {
  const radio = (active: number, busy: number) => ({ accessPoint: "loft", ifname: "phy1-ap0", airtime: { active, busy } });
  const first = airtimeOf([radio(1_000_000, 300_000)], {});
  t.is(first.radios[0].busy, undefined, "one read says nothing yet");
  t.is(airtimeOf([radio(1_010_000, 303_000)], first.counts).radios[0].busy, 30);
  // An NWA50AX Pro's 5 GHz counter, wrapped by mt76 (mt76#1135): it counts on, so the difference holds.
  const wrapped = airtimeOf([radio(59_048_099, 11171887054526208)], {});
  t.is(airtimeOf([radio(59_058_099, 11171887054526208 + 2000)], wrapped.counts).radios[0].busy, 20);
  // Counts gone backwards (a radio restarted, or a driver clearing them): since then, if they can be right.
  t.is(airtimeOf([radio(10_000, 1_000)], first.counts).radios[0].busy, 10);
  t.is(airtimeOf([radio(10_000, 11171887054526208)], first.counts).radios[0].busy, undefined, "busy more than the time measured: not right");
});

const online = (mac: string, over: Partial<ClientView> = {}): ClientView => ({ mac, ipv6: [], connection: { kind: "wired" }, state: "online", reserved: false, heardBy: [], ...over });

test("each client's own numbers: signal, the access point's rate to it, its traffic since the last read", (t) => {
  const wifi = online("aa:00:00:00:00:01", {
    connection: { kind: "wifi", accessPoint: "loft", signal: -61, txRate: 866.7 },
    traffic: { down: 1000, up: 100, over: "month" },
  });
  const first = clientReadingsOf([wifi, online("aa:00:00:00:00:02", { state: "away", traffic: { down: 5, up: 5, over: "month" } })], {}, at(0));
  t.deepEqual(first.readings, { "signal:aa:00:00:00:00:01": -61, "rate:aa:00:00:00:00:01": 866.7 }, "traffic from the next read; nobody away");
  t.deepEqual(Object.keys(first.counts), ["aa:00:00:00:00:01"]);
  const second = clientReadingsOf([{ ...wifi, traffic: { down: 11_000, up: 1100, over: "month" } }], first.counts, at(10));
  t.like(second.readings, { "down:aa:00:00:00:00:01": 8000, "up:aa:00:00:00:00:01": 800 });
  const newMonth = clientReadingsOf([{ ...wifi, traffic: { down: 10, up: 1, over: "month" } }], second.counts, at(20));
  t.false("down:aa:00:00:00:00:01" in newMonth.readings, "a count gone backwards (a new month) gives no rate");
});

test("clients' series: ten-minute points for a day; one client's by name", (t) => {
  const start = 1000 * clientRange.bucketMs;
  let h = withClientReadings({}, start, { "signal:aa": -60, "signal:bb": -70 });
  h = withClientReadings(h, start + at(30), { "signal:aa": -62 });
  t.deepEqual(h["signal:aa"], [[start, -61, 2]]);
  const later = withClientReadings(h, start + clientRange.keepMs + at(1), { "rate:aa": 100 });
  t.deepEqual(Object.keys(later), ["rate:aa"], "a day on, the old points and the clients with none are gone");
  t.deepEqual(historyOfClient({ "signal:aa:bb": [[1, 2, 1]], "rate:aa:bb": [[1, 3, 1]], "signal:cc": [[1, 4, 1]] }, "aa:bb"), {
    signal: [[1, 2, 1]],
    rate: [[1, 3, 1]],
  });
});
