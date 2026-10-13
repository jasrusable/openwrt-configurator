// The web UI's rules for graphs and pages, which are pure: a rate only between
// reads close together, "now" only for a recent reading, every setting on a page.
import test from "ava";
import { fields } from "../../intent/fields";
import { freshMs, latest, rate } from "../../../ui/src/data/history";
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

test("the latest value is now only while it is recent", (t) => {
  const points: [number, number][] = [[0, 1], [at(60), 2]];
  t.is(latest(points, at(60) + freshMs - 1), 2);
  t.is(latest(points, at(60) + freshMs), undefined);
  t.is(latest([], at(0)), undefined);
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
  t.is(whereIs("nowhere.at.all"), undefined);
});
