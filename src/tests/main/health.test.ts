// The four words every Status page colours by, and a client's health with
// its cause: the thresholds of docs/status-redesign.md, held.
import test from "ava";
import { cellTone, clientHealth, needsLook, tone, uptimeOf, worst } from "../../status/health";
import type { ClientView } from "../../status/views";

test("each reading's tone at its thresholds; unknown is off", (t) => {
  t.deepEqual([-60, -67, -70, -75, -80, undefined].map(tone.signal), ["good", "good", "fair", "fair", "poor", "off"]);
  t.deepEqual([10, 30, 59, 60].map(tone.busy), ["good", "fair", "fair", "poor"]);
  t.deepEqual([12, 30, 80].map(tone.latency), ["good", "fair", "poor"]);
  t.deepEqual([0, 1, 2, 25, undefined].map(tone.loss), ["good", "fair", "poor", "poor", "off"]);
  t.deepEqual([0.3, 0.7, 0.95].map(tone.load), ["good", "fair", "poor"]);
  t.deepEqual([61, 70, 86].map(tone.temperature), ["good", "fair", "poor"]);
  t.deepEqual([8, 30, 61].map(tone.bloat), ["good", "fair", "poor"]);
  t.is(tone.latency(NaN), "off");
});

test("the worst of several, what is not known left out", (t) => {
  t.is(worst("good", "off", "fair"), "fair");
  t.is(worst("off", "off"), "off");
  t.is(worst(), "off");
});

const wifi = (over: Partial<Extract<ClientView["connection"], { kind: "wifi" }>> = {}, rest: Partial<ClientView> = {}): ClientView => ({
  mac: "aa:00:00:00:00:01",
  ipv6: [],
  connection: { kind: "wifi", accessPoint: "loft", band: "5 GHz", signal: -58, ...over },
  state: "online",
  reserved: false,
  heardBy: [],
  ...rest,
});

test("a client: good, or what makes it less, each cause named", (t) => {
  t.deepEqual(clientHealth(wifi()), { tone: "good", causes: [] });
  t.deepEqual(clientHealth(wifi({ signal: -79 })), { tone: "poor", causes: [{ kind: "signal", tone: "poor", text: "Weak signal (−79 dBm)" }] });
  t.deepEqual(clientHealth(wifi({ signal: -70 })).causes.map((c) => c.text), ["Fair signal (−70 dBm)"]);
  const busy = clientHealth(wifi(), [{ accessPoint: "loft", ifname: "phy1-ap0", band: "5 GHz", clients: 9, busy: 72 }]);
  t.deepEqual(busy, { tone: "fair", causes: [{ kind: "busy", tone: "fair", text: "Busy channel (72% of the air in use)" }] });
  const sticky = clientHealth(
    wifi({ signal: -74 }, {
      heardBy: [
        { accessPoint: "loft", band: "5 GHz", signal: -74, connected: true },
        { accessPoint: "office", band: "5 GHz", signal: -55, connected: false },
      ],
    })
  );
  t.deepEqual(sticky.causes.map((c) => c.text), ["Fair signal (−74 dBm)", "office hears it 19 dB better"]);
  const slowBand = clientHealth(
    wifi({ band: "2.4 GHz", signal: -60 }, { heardBy: [{ accessPoint: "loft", band: "2.4 GHz", signal: -60, connected: true }, { accessPoint: "loft", band: "5 GHz", signal: -66, connected: false }] })
  );
  t.deepEqual(slowBand.causes.map((c) => c.text), ["On 2.4 GHz, though 5 GHz reaches it"]);
});

test("a client's link rate is never judged: an idle link drops its rate at any signal", (t) => {
  t.is(clientHealth(wifi({ signal: -48, txRate: 1, rxRate: 6 })).tone, "good");
});

test("wired is good, away and unknown are off", (t) => {
  t.is(clientHealth(wifi({}, { connection: { kind: "wired" } })).tone, "good");
  t.is(clientHealth(wifi({}, { state: "away" })).tone, "off");
  t.is(clientHealth(wifi({}, { connection: { kind: "unknown" } })).tone, "off");
});

test("uptime: each point weighed by its reads; nothing read, nothing said", (t) => {
  t.is(uptimeOf([[0, 1, 6], [60_000, 0.5, 6]]), 0.75);
  t.is(uptimeOf([]), undefined);
  t.deepEqual([undefined, 1, 0.9995, 0.7, 0.2].map(cellTone), ["off", "good", "good", "fair", "poor"]);
});

test("worth a look: served poorly, or with something to do; a fair signal alone is ordinary", (t) => {
  t.false(needsLook(clientHealth(wifi({ signal: -70 }))));
  t.true(needsLook(clientHealth(wifi({ signal: -80 }))));
  t.true(needsLook(clientHealth(wifi({ signal: -70 }, { heardBy: [{ accessPoint: "loft", band: "5 GHz", signal: -70, connected: true }, { accessPoint: "office", band: "5 GHz", signal: -55, connected: false }] }))));
  t.false(needsLook(clientHealth(wifi())));
});
