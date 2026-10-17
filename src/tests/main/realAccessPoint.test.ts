// Output recorded once from a real access point (OpenWrt 25.12.5, the user's
// Zyxel NWA50AX Pro), anonymised: every MAC, SSID and address replaced
// consistently. The parsers were written against documented shapes; these
// hold them to what a real hostapd, usteer and iwinfo say.
import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { parseHeardBy, parseWifi } from "../../status/device";
import { neighboursOf, parseSurvey } from "../../status/actions";

const recorded = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "../helpers/status/real-ap", `${name}.json`), "utf8"));

test("a real access point's hostapd: every interface and client read", (t) => {
  const interfaces = parseWifi(recorded("hostapd"));
  t.is(interfaces.length, 4);
  t.is(interfaces.reduce((n, i) => n + (i.clients?.length ?? 0), 0), 19);
  t.true(interfaces.every((i) => i.ssid && i.channel && i.freq), "each with its SSID, channel and frequency");
});

test("a real usteer: each client's view from every node that hears it", (t) => {
  const heard = parseHeardBy(recorded("usteer"));
  t.is(heard.length, 54, "one per client and node that hears it");
  t.is(new Set(heard.map((h) => h.mac)).size <= heard.length, true);
  t.true(heard.some((h) => h.connected) && heard.some((h) => !h.connected), "connected here, and only heard");
});

test("a real survey: every channel's busy time, and the neighbours without our own radios", (t) => {
  const survey = parseSurvey("ap", recorded("survey"));
  t.is(survey.channels.length, 40);
  t.is(survey.own.length, 4, "the access point's own BSSIDs");
  const [read] = neighboursOf([survey], [], true);
  t.is(read.neighbours.length, 34);
  t.true(read.neighbours.every((n) => n.band && n.channel > 0 && n.signal < 0));
});

test("a real access point's channel counters: the survey's entry on each radio's own frequency, as counted (mt76 had wrapped both)", (t) => {
  const surveys = recorded("survey") as { ifname: string; survey: unknown }[];
  const withSurvey = (recorded("hostapd") as { object: string }[]).map((entry) => ({
    ...entry,
    survey: surveys.find((s) => `hostapd.${s.ifname}` === entry.object)?.survey,
  }));
  const wifi = parseWifi(withSurvey);
  t.deepEqual(
    wifi.map((w) => [w.ifname, w.airtime?.active]),
    [
      ["phy0-ap0", 59053605],
      ["phy0-ap1", 59053753],
      ["phy1-ap0", 59048099],
      ["phy1-ap1", 59048249],
    ],
    "rpcd says nothing of which channel is in use: each radio's frequency does"
  );
  t.true(wifi.every((w) => w.airtime!.busy > w.airtime!.active), "wrapped: kept, as the difference between two reads still holds");
});

test("a real access point's clients: the generation from what hostapd says both ends do, its rate left alone", (t) => {
  // hostapd's `rate` here is in tens of bits per second (7220000 is HT MCS 7's 72.2 Mbit/s): read from iwinfo's assoclist instead.
  const clients = parseWifi(recorded("hostapd")).flatMap((w) => w.clients);
  t.true(clients.every((c) => c.txRate === undefined && c.rxRate === undefined));
  t.true(clients.some((c) => c.generation === 6) && clients.some((c) => c.generation === 4), "HE clients and HT-only ones");
  t.true(clients.every((c) => c.signal === undefined || c.signal < 0));
});
