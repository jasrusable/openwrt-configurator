// Status › Devices' actions: reboot, restart Wi-Fi, ping. Parsers and rules
// are pure; the routes are checked only where they answer before reaching a
// device (the sample's addresses may be a real network's). The commands were
// run on 25.12.5 over dbclient: a detached one answers at once and runs after
// the session closes; a reboot answers, then goes down.
import test from "ava";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";
import { uiHandler } from "../../server/app";
import { parsePing, parseTraceroute, pingTarget, stillRebooting, withRebooting } from "../../status/actions";
import { sampleIntentText } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

test("a ping's summary: sent, answered and the average; none when ping could not run", (t) => {
  t.deepEqual(
    parsePing("--- 1.1.1.1 ping statistics ---\n4 packets transmitted, 3 packets received, 25% packet loss\nround-trip min/avg/max = 9.1/12.4/20.0 ms\n"),
    { sent: 4, received: 3, averageMs: 12.4 }
  );
  t.deepEqual(parsePing("4 packets transmitted, 0 packets received, 100% packet loss\n"), { sent: 4, received: 0 });
  t.is(parsePing("ping: bad address 'no.such.host'\n"), undefined);
});

// Recorded from busybox 1.37.0 in the 25.12.5 rootfs, the addresses replaced with documentation ones.
test("a traceroute's hops: who answered and in what time, a lost probe counted", (t) => {
  const hops = parseTraceroute(readFileSync(join(__dirname, "../helpers/status/traceroute.txt"), "utf8"));
  t.is(hops.length, 7);
  t.deepEqual(hops[0], { hop: 1, address: "192.0.2.1", ms: [0.005, 0.003], lost: 0 });
  t.deepEqual(hops[2], { hop: 3, address: "100.64.0.1", ms: [5.474], lost: 1 });
  t.deepEqual(hops[6], { hop: 7, ms: [], lost: 2 });
  t.deepEqual(parseTraceroute("traceroute: bad address 'nosuch.invalid'\n"), []);
});

test("a ping's target is an address or a name, never an option or shell text", (t) => {
  for (const ok of ["1.1.1.1", "2606:4700::1111", "example.com", "home-ap-1.lan"]) t.true(pingTarget.test(ok), ok);
  for (const bad of ["-f", "-c1000", "a;reboot", "$(reboot)", "a b", "", "x`y`"]) t.false(pingTarget.test(bad), bad);
});

test("a device asked to reboot is rebooting until it answers with a fresh uptime, ten minutes at most", (t) => {
  const asked = 1_000_000;
  t.true(stillRebooting(asked, { reachable: true, uptime: 3600 }, asked + 5_000), "not gone down yet: its uptime is from before");
  t.true(stillRebooting(asked, { reachable: false }, asked + 30_000), "down");
  t.false(stillRebooting(asked, { reachable: true, uptime: 20 }, asked + 60_000), "back: up 20 s, a minute after the request");
  t.false(stillRebooting(asked, { reachable: false }, asked + 11 * 60_000), "past ten minutes it is just not reached");
  const status = { deviceViews: [{ name: "ap", role: "access-point", reachable: false, ports: [] }, { name: "router", role: "router", reachable: true, uptime: 9, ports: [] }] };
  t.deepEqual(
    withRebooting(status, { ap: asked }, asked + 10_000).deviceViews!.map((d) => [d.name, !!(d as { rebooting?: boolean }).rebooting]),
    [["ap", true], ["router", false]]
  );
});

test("the action routes refuse what they cannot act on before reaching any device", async (t) => {
  const dir = tempDir("actions");
  const intentPath = join(dir, "intent.json");
  writeFileSync(intentPath, sampleIntentText(), { mode: 0o600 });
  const handle = uiHandler({ intentPath, uiRoot: dir, platform: nodePlatform });
  const post = (path: string, body: unknown) => handle({ method: "POST", path, body: JSON.stringify(body), headers: { "x-onc": "1" } });
  t.is((await post("/api/device/reboot", {})).status, 400);
  t.is((await post("/api/device/wifi-restart", { device: "" })).status, 400);
  t.is((await post("/api/device/ping", { device: "home-router", target: "-f" })).status, 400);
  t.is((await post("/api/device/traceroute", { device: "home-router", target: "$(reboot)" })).status, 400);
  t.is((await post("/api/device/reboot", { device: "no-such-device" })).status, 404);
});
