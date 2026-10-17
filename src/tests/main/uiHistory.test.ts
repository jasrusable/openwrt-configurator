// The graphs' rules, which are pure: a rate only between reads close
// together, a minute's mean, what is new merged over what is held; and
// every setting on a page.
import test from "ava";
import { fields } from "../../intent/fields";
import { bucketMs, historySince, keepMs, mergeHistory, ranges, rate, rounded, throughputOf, withReadings, withReadingsEverywhere, withSample } from "../../status/history";
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

test("a series no longer read is pruned with the rest: a day on, its points are gone, not drawn as current", (t) => {
  const h = withReadings({ latency: [[0, 9, 1]], clients: [[0, 4, 1], [3 * bucketMs, 5, 1]], down: [[0, 1, 1]] }, keepMs + bucketMs, { down: 2 }, []);
  t.deepEqual(h, { clients: [[3 * bucketMs, 5, 1]], down: [[keepMs + bucketMs, 2, 1]] });
});

test("stored means are rounded to four significant digits", (t) => {
  t.deepEqual(rounded({ down: [[0, 123456789.123, 3]], load: [[0, 0.123456, 2]] }), { down: [[0, 123500000, 3]], load: [[0, 0.1235, 2]] });
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
  t.deepEqual(whereIs("internet.lines.1.shaping.down_mbps"), { page: "internet", url: "/internet/1" });
  t.deepEqual(whereIs("wifi.radios.5g.width"), { page: "wifi", url: "/wifi/radios/5g" });
  t.deepEqual(whereIs("vpn.remote_access.clients.0.name"), { page: "vpn", url: "/vpn/0" });
  t.deepEqual(whereIs("dns.upstream"), { page: "dns", url: "/dns" });
  t.deepEqual(whereIs("system.patches"), { page: "system", url: "/system/patches" });
  t.deepEqual(whereIs("system.patches.off.0"), { page: "system", url: "/system/patches" });
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
