// Events from two reads: what changed, when, in words; what happened between
// reads where a device keeps a time for it; nothing from one slow answer.
import test from "ava";
import { eventsBetween, keepEvents, lasted, missesForLost, NetworkEvent, Observed, observe } from "../../status/events";
import type { NetworkStatus } from "../../status/network";
import type { DeviceView } from "../../status/views";

type Connection = NetworkStatus["connections"][number];

const line = (id: string, over: Partial<Connection> = {}): Connection => ({ id, name: id === "wan" ? "Fibre" : "Backup", up: true, ipv4: [], ipv6: [], inUse: id === "wan", ...over });
const device = (name: string, over: Partial<DeviceView> = {}): DeviceView => ({ name, role: name === "router" ? "router" : "access-point", reachable: true, uptime: 1000, ports: [], services: [], ...over });

const status = (over: Partial<NetworkStatus> = {}): NetworkStatus => ({
  internet: { up: true, ipv4: [], ipv6: [] },
  connections: [line("wan")],
  devices: [],
  networks: [],
  ssids: [],
  clients: { total: 0, wifi: 0 },
  unexpected: { interfaces: [], ssids: [] },
  deviceViews: [device("router"), device("loft")],
  radios: [],
  ...over,
});

/** Reads in turn, each `stepMs` after the last, uptimes moving on with the clock unless a read says otherwise; the events of each step. */
const run = (reads: NetworkStatus[], stepMs = 10_000, start = 1_000_000) =>
  reads.reduce<{ observed?: Observed; events: NetworkEvent[] }>(
    ({ observed, events }, s, i) => {
      const next = observe(s, start + i * stepMs, observed);
      return { observed: next, events: [...events, ...eventsBetween(observed, next)] };
    },
    { events: [] }
  ).events;

const words = (events: NetworkEvent[]) => events.map((e) => e.text);

test("nothing before there is a read to compare with", (t) => {
  t.deepEqual(eventsBetween(undefined, observe(status(), 0)), []);
});

test("a line going down and coming back: when, and for how long", (t) => {
  const events = run([
    status({ connections: [line("wan", { uptime: 100 })] }),
    status({ connections: [line("wan", { up: false, inUse: false })] }),
    status({ connections: [line("wan", { up: false, inUse: false })] }),
    status({ connections: [line("wan", { uptime: 5 })] }),
  ]);
  // Down from the first read that saw it (10 s in), up 5 s at the read 30 s in: 15 s down.
  t.deepEqual(words(events), ["Fibre went down", "Fibre came back after 15 s"]);
  t.like(events[0], { kind: "line", severity: "problem", subject: "line:wan", at: 1_010_000 });
  t.like(events[1], { severity: "ok", at: 1_025_000 });
});

test("a drop shorter than the reads: up at both, yet up for less than lay between them", (t) => {
  const events = run(
    [status({ connections: [line("wan", { uptime: 3600 })] }), status({ connections: [line("wan", { uptime: 15 })] })],
    60_000
  );
  t.deepEqual(words(events), ["Fibre dropped and came back"]);
  t.like(events[0], { severity: "warning", at: 1_000_000 + 60_000 - 15_000 });
  // Up as long as the reads say: nothing to tell.
  t.deepEqual(run([status({ connections: [line("wan", { uptime: 3600 })] }), status({ connections: [line("wan", { uptime: 3660 })] })], 60_000), []);
});

test("mwan3's own time in its state says when a line failed, between reads", (t) => {
  const events = run(
    [
      status({ connections: [line("wan", { line: { state: "online", since: 500 } }), line("wanb", { inUse: false, line: { state: "online", since: 500 } })] }),
      status({
        connections: [
          line("wan", { inUse: false, line: { state: "offline", since: 40 } }),
          line("wanb", { inUse: true, line: { state: "online", since: 560 } }),
        ],
      }),
      status({
        connections: [line("wan", { inUse: true, line: { state: "online", since: 2 } }), line("wanb", { inUse: false, line: { state: "online", since: 620 } })],
      }),
    ],
    60_000
  );
  // Offline from 20 s in (40 s at the read a minute in), online 2 s at the read two minutes in.
  t.deepEqual(words(events), ["Fibre went down", "Traffic moved to Backup", "Fibre came back after 98 s", "Traffic is back on Fibre"]);
  t.is(events[0].at, 1_060_000 - 40_000, "offline 40 s at the read");
  t.like(events[1], { kind: "failover", severity: "warning" });
  t.like(events[3], { kind: "failover", severity: "ok" });
});

test("the router not read: nothing said of the lines, and they are not taken for down", (t) => {
  const unread = status({ internet: undefined, connections: [line("wan", { up: undefined, inUse: undefined })] });
  t.deepEqual(words(run([status(), unread, status({ connections: [line("wan", { uptime: 1030 })] })])), []);
});

test(`a device is lost only after ${missesForLost} reads in a row; one slow answer says nothing`, (t) => {
  const gone = device("loft", { reachable: false, uptime: undefined });
  t.deepEqual(words(run([status(), status({ deviceViews: [device("router"), gone] }), status({ deviceViews: [device("router"), device("loft", { uptime: 1020 })] })])), []);
  const events = run([
    status(),
    status({ deviceViews: [device("router"), gone] }),
    status({ deviceViews: [device("router"), gone] }),
    status({ deviceViews: [device("router"), gone] }),
    status({ deviceViews: [device("router"), device("loft", { uptime: 3000 })] }),
  ]);
  t.deepEqual(words(events), ["loft stopped answering", "loft answers again after 30 s"]);
  t.is(events[0].at, 1_010_000, "from its first missed read");
  t.like(events[0], { kind: "device", severity: "problem", device: "loft", subject: "device:loft" });
});

test("a device never seen since the collector started is not said to stop", (t) => {
  const gone = device("loft", { reachable: false, uptime: undefined });
  t.deepEqual(run([status({ deviceViews: [device("router"), gone] }), status({ deviceViews: [device("router"), gone] }), status({ deviceViews: [device("router"), gone] })]), []);
});

test("a restart: back with an uptime shorter than its silence, or answering both times with its clock started again", (t) => {
  const gone = device("loft", { reachable: false, uptime: undefined });
  const back = run([status(), status({ deviceViews: [device("router"), gone] }), status({ deviceViews: [device("router"), gone] }), status({ deviceViews: [device("router"), device("loft", { uptime: 12 })] })]);
  // In the order they happened: it restarted before the read that found it back.
  t.deepEqual(words(back), ["loft stopped answering", "loft restarted", "loft answers again after 20 s"]);
  t.like(back[1], { kind: "reboot", at: 1_030_000 - 12_000 });
  const quick = run([status(), status({ deviceViews: [device("router", { uptime: 40 }), device("loft", { uptime: 1060 })] })], 60_000);
  t.deepEqual(words(quick), ["router restarted"]);
  t.is(quick[0].at, 1_060_000 - 40_000);
  // Its uptime moved on with the clock: no restart.
  t.deepEqual(run([status(), status({ deviceViews: [device("router", { uptime: 1060 }), device("loft", { uptime: 1060 })] })], 60_000), []);
});

test("a service stopping and running again; a port connecting, disconnecting and slowing down", (t) => {
  const svc = (running: boolean) => [{ name: "odhcpd", running }];
  const port = (up: boolean, speed?: number) => [{ name: "lan1", up, ...(speed ? { speed } : {}) }];
  const events = run([
    status({ deviceViews: [device("router", { services: svc(true), ports: port(false) }), device("loft")] }),
    status({ deviceViews: [device("router", { services: svc(false), ports: port(true, 1000), uptime: 1010 }), device("loft", { uptime: 1010 })] }),
    status({ deviceViews: [device("router", { services: svc(true), ports: port(true, 100), uptime: 1020 }), device("loft", { uptime: 1020 })] }),
    status({ deviceViews: [device("router", { services: svc(true), ports: port(false), uptime: 1030 }), device("loft", { uptime: 1030 })] }),
  ]);
  t.deepEqual(words(events), [
    "odhcpd stopped on router",
    "lan1 on router connected at 1 Gbit/s",
    "odhcpd is running again on router",
    "lan1 on router slowed to 100 Mbit/s (was 1 Gbit/s)",
    "lan1 on router disconnected",
  ]);
  t.like(events[3], { kind: "port", severity: "warning", subject: "port:router:lan1" });
});

test("an SSID off the air and back at an access point; a mesh link lost and back", (t) => {
  const radio = (ssid: string) => ({ accessPoint: "loft", ifname: `phy1-${ssid}`, ssid, clients: 0 });
  const mesh = (to: string[]) => [{ name: "loft", links: to.map((t) => ({ to: t, throughput: 100 })) }];
  const events = run([
    status({ radios: [radio("Home"), radio("Guest")], mesh: mesh(["router"]) }),
    status({ radios: [radio("Home")], mesh: mesh([]), deviceViews: [device("router", { uptime: 1010 }), device("loft", { uptime: 1010 })] }),
    status({ radios: [radio("Home"), radio("Guest")], mesh: mesh(["router"]), deviceViews: [device("router", { uptime: 1020 }), device("loft", { uptime: 1020 })] }),
  ]);
  t.deepEqual(words(events), ["“Guest” went off the air at loft", "loft lost its mesh link to router", "“Guest” is on the air again at loft", "loft linked to router over the mesh"]);
});

test("an access point not reached: its SSIDs are not said to go off the air", (t) => {
  const radio = { accessPoint: "loft", ifname: "phy1-ap0", ssid: "Home", clients: 0 };
  const gone = device("loft", { reachable: false, uptime: undefined });
  t.deepEqual(
    words(run([status({ radios: [radio] }), status({ radios: [], deviceViews: [device("router"), gone] }), status({ radios: [radio], deviceViews: [device("router"), device("loft", { uptime: 1020 })] })])),
    []
  );
});

test("kept: newest first, the same event twice kept once, older than 30 days dropped", (t) => {
  const e = (at: number, text: string): NetworkEvent => ({ at, kind: "line", severity: "info", subject: "line:wan", text });
  const day = 24 * 3600_000;
  t.deepEqual(keepEvents([e(1000, "a"), e(500, "b")], [e(1500, "a"), e(3000, "c")], 4000).map((x) => [x.at, x.text]), [[3000, "c"], [1500, "a"], [500, "b"]]);
  t.deepEqual(keepEvents([e(1000, "old")], [e(31 * day, "new")], 31 * day).map((x) => x.text), ["new"]);
});

test("how long something lasted, in words", (t) => {
  t.deepEqual([lasted(4_000), lasted(98_000), lasted(150_000), lasted(3_600_000), lasted(3_900_000), lasted(4 * 24 * 3_600_000)], ["4 s", "98 s", "3 min", "1 h", "1 h 5 min", "4 days"]);
});
