// The Status pages over a made-up day, offline: a network of a router and
// two access points (one by cable, one over the mesh), two lines, two dozen
// clients, a day and a month of history with an outage, a failover and a
// restart in it, events, remembered clients and speed tests; then the UI,
// served on a frozen clock so the snapshot stays the one shown. For looking
// at the pages while building them, and screenshots.
//
//   npx ts-node --transpile-only scripts/status-preview.ts [--port 8090]
//
// Nothing here reaches a device: the networks are in TEST-NET ranges
// (192.0.2.0/24, 198.51.100.0/24), so the router's address answers nothing,
// and the access points have no facts to be found by. Build the UI first
// (npm run ui:build).
import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { nodePlatform } from "../src/platforms/node";
import { uiHandler } from "../src/server/app";
import { stateLayout, write } from "../src/store";
import { digest, eventsKey, registryKey, State } from "../src/status/collector";
import type { NetworkEvent } from "../src/status/events";
import { History, radioKey, ranges } from "../src/status/history";
import type { NetworkStatus } from "../src/status/network";
import type { Registry } from "../src/status/registry";
import type { ClientView, DeviceView, RadioView } from "../src/status/views";
import { readFileSync } from "fs";
import { z } from "zod";

const port = Number(process.argv[process.argv.indexOf("--port") + 1] || 8090) || 8090;
const now = Date.now();
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

// A seeded random, so every run shows the same network.
let seed = 42;
const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
const between = (a: number, b: number) => a + random() * (b - a);

const dir = mkdtempSync(join(tmpdir(), "onc-preview-"));
const intentPath = join(dir, "intent.json");
const sample = JSON.parse(readFileSync(join(__dirname, "../sampleConfigs/intent.json"), "utf8"));
const intent = {
  ...sample,
  system: { ...sample.system, name: "Hillside" },
  networks: sample.networks.map((n: { id: string }) => ({ ...n, subnet: n.id === "lan" ? "192.0.2.0/24" : "198.51.100.0/24" })),
  internet: { ...sample.internet, lines: [...sample.internet.lines, { id: "wanb", name: "LTE", type: "dhcp", port: "lan4", failover: { metered: true } }] },
  hardware: [
    { name: "router", role: "router" },
    { name: "office", role: "access-point" },
    { name: "loft", role: "access-point", uplink: "mesh" },
  ],
  wifi: { ...sample.wifi, mesh: { ...(sample.wifi?.mesh ?? {}), enabled: true } },
};
writeFileSync(intentPath, JSON.stringify(intent, null, 2));
chmodSync(intentPath, 0o600);
const statusDir = stateLayout(intentPath).status;

// The clients: name, kind, model, where, signal, how much.
const people: [string, ClientView["kind"], string | undefined, string, string, number][] = [
  ["Jason's iPhone", "phone", "iPhone16,1", "loft", "5 GHz", -58],
  ["Sam's Pixel", "phone", "Pixel 8", "office", "5 GHz", -63],
  ["MacBook Pro", "laptop", "Mac15,9", "office", "5 GHz", -52],
  ["Work laptop", "laptop", undefined, "loft", "5 GHz", -71],
  ["Living room TV", "tv", "Bravia", "office", "5 GHz", -66],
  ["Kitchen speaker", "speaker", "HomePod mini", "office", "2.4 GHz", -61],
  ["Bedroom speaker", "speaker", "Sonos One", "loft", "2.4 GHz", -77],
  ["iPad", "tablet", "iPad13,18", "loft", "5 GHz", -60],
  ["Apple Watch", "watch", "Watch7,1", "loft", "2.4 GHz", -69],
  ["Printer", "printer", "HP OfficeJet", "office", "2.4 GHz", -64],
  ["Front door camera", "camera", undefined, "office", "2.4 GHz", -79],
  ["PlayStation", "console", "PS5", "office", "5 GHz", -55],
  ["Thermostat", "iot", undefined, "loft", "2.4 GHz", -73],
  ["Hall lights", "iot", undefined, "office", "2.4 GHz", -68],
  ["Guest phone", "phone", undefined, "office", "5 GHz", -65],
  ["Desktop", "computer", undefined, "", "", 0],
  ["NAS", "computer", undefined, "", "", 0],
];
const macOf = (i: number) => (i === 14 ? "da:4f:31:00:00:0e" : `a4:83:e7:00:00:${i.toString(16).padStart(2, "0")}`);

const clients = (t: number): ClientView[] =>
  people.map(([name, kind, model, ap, band, signal], i) => {
    const wired = !ap;
    const jitter = Math.round(between(-3, 3));
    const guest = i === 14;
    return {
      mac: macOf(i),
      name,
      ...(kind ? { kind } : {}),
      ...(model ? { model } : {}),
      ipv4: guest ? `198.51.100.${20 + i}` : `192.0.2.${20 + i}`,
      ipv6: guest ? [] : [`2001:db8:12:0:${(i + 1).toString(16)}::1`],
      network: guest ? "guest" : "lan",
      connection: wired
        ? { kind: "wired" as const }
        : {
            kind: "wifi" as const,
            accessPoint: ap,
            ssid: guest ? "Home Guests" : "Home",
            band,
            channel: band === "5 GHz" ? (ap === "loft" ? 36 : 100) : ap === "loft" ? 11 : 1,
            signal: signal + jitter,
            connected: 3 * 3600 + i * 600,
            txRate: band === "5 GHz" ? Math.round(between(300, 1200)) : Math.round(between(30, 140)),
            rxRate: band === "5 GHz" ? Math.round(between(200, 900)) : Math.round(between(20, 100)),
            generation: band === "5 GHz" ? 6 : 4,
          },
      state: i === 6 && t < now - 30 * minute ? "recent" : "online",
      reserved: i === 16 || i === 9,
      traffic: { down: Math.round((i + 1) * 3.1e9 + (t % day) * 400), up: Math.round((i + 1) * 4e8 + (t % day) * 40), over: "month" },
      heardBy:
        i === 3
          ? [
              { accessPoint: "loft", band: "5 GHz", signal: -71, connected: true },
              { accessPoint: "office", band: "5 GHz", signal: -56, connected: false },
            ]
          : i === 12
            ? [
                { accessPoint: "loft", band: "2.4 GHz", signal: -73, connected: true },
                { accessPoint: "loft", band: "5 GHz", signal: -68, connected: false },
              ]
            : [],
    };
  });

const radios = (busyLoft: number): RadioView[] =>
  [
    { accessPoint: "office", ifname: "phy0-ap0", band: "2.4 GHz", channel: 1, htmode: "HE20", ssid: "Home" },
    { accessPoint: "office", ifname: "phy0-ap1", band: "2.4 GHz", channel: 1, htmode: "HE20", ssid: "Home Guests" },
    { accessPoint: "office", ifname: "phy1-ap0", band: "5 GHz", channel: 100, htmode: "HE80", ssid: "Home" },
    { accessPoint: "office", ifname: "phy1-ap1", band: "5 GHz", channel: 100, htmode: "HE80", ssid: "Home Guests" },
    { accessPoint: "loft", ifname: "phy0-ap0", band: "2.4 GHz", channel: 11, htmode: "HE20", ssid: "Home" },
    { accessPoint: "loft", ifname: "phy1-ap0", band: "5 GHz", channel: 36, htmode: "HE80", ssid: "Home" },
  ].map((r) => ({
    ...r,
    noise: r.band === "5 GHz" ? -92 : -89,
    txpower: r.band === "5 GHz" ? 23 : 20,
    clients: people.filter(([, , , ap, band], i) => ap === r.accessPoint && band === r.band && (i === 14) === (r.ssid === "Home Guests")).length,
    // Running totals, as the radios keep them: two reads give how busy.
    airtime: { active: 50_000_000 + (now % day), busy: Math.round((50_000_000 + (now % day)) * (r.accessPoint === "loft" && r.band === "5 GHz" ? busyLoft : r.band === "2.4 GHz" ? 0.38 : 0.18)) },
  }));

const device = (name: string, role: string, model: string, over: Partial<DeviceView> = {}): DeviceView => ({
  name,
  role,
  model,
  version: name === "loft" ? "25.12.4" : "25.12.5",
  reachable: true,
  // Seconds, as the devices say.
  uptime: name === "loft" ? 5 * 3600 : 12 * 86400,
  load: name === "router" ? 0.9 : 0.3,
  cores: name === "router" ? 4 : 2,
  memoryUsed: name === "router" ? 0.46 : 0.62,
  storage: { availableKb: name === "router" ? 98_000 : 12_000, totalKb: 120_000 },
  temperature: name === "router" ? 58 : name === "loft" ? 72 : 49,
  ports:
    name === "router"
      ? [
          { name: "wan", up: true, speed: 1000 },
          { name: "lan1", up: true, speed: 1000 },
          { name: "lan2", up: true, speed: 100 },
          { name: "lan3", up: false },
          { name: "lan4", up: true, speed: 1000 },
        ]
      : name === "office"
        ? [{ name: "lan", up: true, speed: 1000 }]
        : [{ name: "lan", up: false }],
  services: [
    { name: "dnsmasq", running: true },
    { name: "odhcpd", running: true },
    ...(name === "router" ? [{ name: "https-dns-proxy", running: true }, { name: "mwan3", running: true }, { name: "sqm", running: true }] : [{ name: "usteer", running: true }]),
  ],
  log: [
    { at: now - 5 * hour, text: "procd: - init complete -", said: "Started up", tone: "start" },
    { at: now - 5 * hour + 20_000, text: "hostapd: phy1-ap0: AP-ENABLED", said: "Wi-Fi phy1-ap0 on", tone: "up" },
    { at: now - 2 * hour, text: "netifd: Network device 'lan' link is down", said: "Port lan disconnected", tone: "down" },
  ],
  ...over,
});

const read = (t: number, wanCount: number, busyLoft: number): NetworkStatus => ({
  internet: { up: true, ipv4: ["203.0.113.7/24"], ipv6: ["2001:db8:12::1/64"], uptime: 3 * 3600 },
  connections: [
    {
      id: "wan",
      name: "Fibre",
      up: true,
      ipv4: ["203.0.113.7/24"],
      ipv6: ["2001:db8:12::1/64"],
      uptime: 3 * 3600 - 22 * 60,
      line: { state: "online", since: 3 * 3600 - 22 * 60 },
      inUse: true,
      proto: "dhcp",
      gateway: "203.0.113.1",
      prefixes: ["2001:db8:12::/56"],
      dns: ["203.0.113.53"],
      device: "eth1",
    },
    { id: "wanb", name: "LTE", up: true, ipv4: ["100.64.3.2/22"], ipv6: [], uptime: 12 * 86400, line: { state: "online", since: 12 * 86400 }, inUse: false, proto: "dhcp", gateway: "100.64.0.1", device: "eth4" },
  ],
  devices: intent.hardware.map((h: { name: string; role: string }) => ({ name: h.name, role: h.role, health: { uptime: 1, load: 0.3, memoryUsed: 0.5 } })),
  networks: [
    { id: "lan", name: "Home", up: true, clients: 16 },
    { id: "guest", name: "Guests", up: true, clients: 1 },
  ],
  ssids: [
    { ssid: "Home", accessPoints: ["office", "loft"], clients: 14 },
    { ssid: "Home Guests", accessPoints: ["office"], clients: 1 },
  ],
  clients: { total: 17, wifi: 15 },
  mesh: [
    { name: "loft", links: [{ to: "router", throughput: 142 }] },
    { name: "router", links: [{ to: "loft", throughput: 142 }] },
  ],
  unexpected: { interfaces: [], ssids: [] },
  attention: [
    { id: "temperature:loft", severity: "warning", title: "loft is running warm", detail: "72 °C." },
    { id: "storage:office", severity: "warning", title: "office is nearly out of storage", detail: "11 MiB free: an apply that installs packages could fail." },
    { id: "apply:pending", severity: "info", title: "Saved settings are not applied yet", detail: "Your devices still run the settings applied before.", link: "?apply" },
  ],
  clientList: clients(t),
  deviceViews: [device("router", "router", "GL.iNet GL-MT6000"), device("office", "access-point", "Zyxel NWA50AX Pro"), device("loft", "access-point", "Zyxel NWA50AX Pro")],
  radios: radios(busyLoft),
  internetCheck: { latencyMs: 11.4, lossPercent: 0, jitterMs: 1.8, gateway: "203.0.113.1", gatewayMs: 2.1, gatewayLossPercent: 0, publicIpv4: "203.0.113.7", dnsOk: true, doh: [{ port: 5053, ok: true }, { port: 5054, ok: true }], queues: [{ device: "eth1", sentBytes: 9e11, dropped: 2400 }] },
  internetCounters: { lines: { wan: { rx: wanCount, tx: wanCount / 8 }, wanb: { rx: 1e6, tx: 1e5 } }, at: t },
  reservations: [macOf(16), macOf(9)],
});

// History: a point a minute for a day, every 15 minutes for 30 days.
const series = (rule: { bucketMs: number; keepMs: number }, value: (t: number) => number | undefined): [number, number, number][] => {
  const out: [number, number, number][] = [];
  for (let t = now - rule.keepMs + rule.bucketMs; t <= now; t += rule.bucketMs) {
    const bucket = t - (t % rule.bucketMs);
    // Not watched for two hours eight days ago, and an hour last night: gaps, never good.
    if ((now - t > 8 * day && now - t < 8 * day + 2 * hour) || (now - t > 10 * hour && now - t < 11 * hour)) continue;
    const v = value(bucket);
    if (v !== undefined) out.push([bucket, v, rule.bucketMs === minute ? 6 : 15]);
  }
  return out;
};
const daily = (t: number) => Math.sin(((t % day) / day) * 2 * Math.PI - Math.PI / 2) * 0.5 + 0.5;
const outage = (t: number) => now - t > 3 * hour + 4 * minute && now - t < 3 * hour + 22 * minute;
const historyFor = (rule: { bucketMs: number; keepMs: number }): History => {
  const h: History = {
    down: series(rule, (t) => (outage(t) ? 0 : 4e6 + daily(t) * 180e6 * between(0.4, 1.2))),
    up: series(rule, (t) => (outage(t) ? 0 : 1e6 + daily(t) * 25e6 * between(0.4, 1.2))),
    latency: series(rule, (t) => (outage(t) ? undefined : 10 + daily(t) * 6 + between(0, 4) + (now - t > 5 * day && now - t < 5 * day + 3 * hour ? 60 : 0))),
    gateway: series(rule, () => 2 + between(0, 1.5)),
    loss: series(rule, (t) => (outage(t) ? 100 : random() < 0.03 ? 25 : 0)),
    jitter: series(rule, () => between(0.5, 4)),
    internet: series(rule, (t) => (outage(t) ? 0.1 : 1)),
    "line:wan": series(rule, (t) => (outage(t) ? 0 : 1)),
    "line:wanb": series(rule, () => 1),
    clients: series(rule, (t) => Math.round(9 + daily(t) * 8)),
  };
  for (const name of ["router", "office", "loft"]) {
    h[`load:${name}`] = series(rule, (t) => (name === "router" ? 0.1 + daily(t) * 0.5 : 0.05 + daily(t) * 0.2) + between(0, 0.1));
    h[`memory:${name}`] = series(rule, () => (name === "router" ? 0.45 : 0.6) + between(0, 0.03));
    h[`temperature:${name}`] = series(rule, (t) => (name === "router" ? 52 : name === "loft" ? 64 : 47) + daily(t) * 8 + between(-1, 1));
  }
  for (const r of radios(0.5)) {
    h[radioKey("clients", r.accessPoint, r.band!)] = series(rule, (t) => Math.round(daily(t) * 6));
    h[radioKey("busy", r.accessPoint, r.band!)] = series(rule, (t) => (r.accessPoint === "loft" && r.band === "5 GHz" ? 20 + daily(t) * 50 : r.band === "2.4 GHz" ? 30 + daily(t) * 15 : 8 + daily(t) * 15) + between(-3, 3));
  }
  return h;
};

const events: NetworkEvent[] = [
  { at: now - 3 * hour - 22 * minute, kind: "line", severity: "ok", subject: "line:wan", text: "Fibre came back after 18 min" },
  { at: now - 3 * hour - 22 * minute, kind: "failover", severity: "ok", subject: "line:wan", text: "Traffic is back on Fibre" },
  { at: now - 3 * hour - 4 * minute, kind: "failover", severity: "warning", subject: "line:wanb", text: "Traffic moved to LTE" },
  { at: now - 3 * hour - 4 * minute, kind: "line", severity: "problem", subject: "line:wan", text: "Fibre went down" },
  { at: now - 2 * hour, kind: "port", severity: "info", subject: "port:loft:lan", device: "loft", text: "lan on loft disconnected" },
  { at: now - 5 * hour, kind: "reboot", severity: "warning", subject: "device:loft", device: "loft", text: "loft restarted" },
  { at: now - 5 * hour + 40_000, kind: "mesh", severity: "ok", subject: "mesh:loft", device: "loft", text: "loft linked to router over the mesh" },
  { at: now - 7 * hour, kind: "client", severity: "info", subject: `client:${macOf(14)}`, device: "office", text: "New device: Guest phone on Guests" },
  { at: now - 26 * hour, kind: "apply", severity: "ok", subject: "app:apply", text: "Settings applied" },
  { at: now - 26 * hour - 5 * minute, kind: "service", severity: "ok", subject: "service:router:odhcpd", device: "router", text: "odhcpd is running again on router" },
  { at: now - 5 * day, kind: "line", severity: "warning", subject: "line:wan", text: "Fibre dropped and came back" },
];

const registry: Registry = {
  since: now - 20 * day,
  clients: Object.fromEntries([
    ...people.map(([name, kind, model], i) => [macOf(i), { mac: macOf(i), name, ...(kind ? { kind } : {}), ...(model ? { model } : {}), firstSeen: i === 14 ? now - 7 * hour : now - 19 * day + i * hour, lastSeen: now - minute, network: i === 14 ? "guest" : "lan" }]),
    ["a4:83:e7:00:00:40", { mac: "a4:83:e7:00:00:40", name: "Old Kindle", firstSeen: now - 18 * day, lastSeen: now - 6 * day, network: "lan", connection: "wifi", accessPoint: "office", band: "2.4 GHz" }],
  ]),
};

const clientHistory: History = Object.fromEntries(
  people.flatMap(([, , , ap, band, signal], i) =>
    ap
      ? [
          [`signal:${macOf(i)}`, series({ bucketMs: 10 * minute, keepMs: day }, () => signal + between(-4, 4))],
          [`rate:${macOf(i)}`, series({ bucketMs: 10 * minute, keepMs: day }, (t) => (band === "5 GHz" ? 200 + daily(t) * 800 : 20 + daily(t) * 100))],
          [`down:${macOf(i)}`, series({ bucketMs: 10 * minute, keepMs: day }, (t) => daily(t) * between(1e5, 2e7))],
          [`up:${macOf(i)}`, series({ bucketMs: 10 * minute, keepMs: day }, (t) => daily(t) * between(1e4, 2e6))],
        ]
      : []
  )
);

// The last two reads through the collector's own digest: busy channels, throughput, every client marked.
const start: State = { histories: { day: historyFor(ranges.day), month: historyFor(ranges.month) }, counts: {}, events: [...events].sort((a, b) => b.at - a.at), registry, clientHistory };
const first = digest({ read: read(now - 10_000, 5e12, 0.5), at: now - 10_000, state: start });
const last = digest({ read: read(now, 5e12 + 120e6, 0.5), at: now, state: first.state, networkName: (id) => (id === "lan" ? "Home" : "Guests") });
const keyOf = (name: string) => ({ path: join(statusDir, name), schema: z.custom<unknown>(() => true), format: 1 });
write(nodePlatform, { ...keyOf("status.json") }, last.snapshot);
write(nodePlatform, keyOf("history.json"), last.state.histories.day);
write(nodePlatform, keyOf("history-month.json"), last.state.histories.month);
write(nodePlatform, keyOf("client-history.json"), last.state.clientHistory);
write(nodePlatform, eventsKey(statusDir), last.state.events ?? []);
write(nodePlatform, registryKey(statusDir), last.state.registry!);
write(nodePlatform, { path: stateLayout(intentPath).speedTests, schema: z.custom<unknown>(() => true), format: 1 }, [
  { at: now - 2 * hour, downMbps: 912.4, upMbps: 108.3, idleMs: 9.8, downLoadedMs: 21.4, upLoadedMs: 18.9 },
  { at: now - 2 * day, downMbps: 884.1, upMbps: 104.9, idleMs: 10.2, downLoadedMs: 44.1, upLoadedMs: 23.0 },
]);

console.log(`Preview of ${intentPath} at http://127.0.0.1:${port}/ (Ctrl-C to stop)`);
void nodePlatform.serve(uiHandler({ intentPath, uiRoot: join(__dirname, "../dist/ui"), platform: nodePlatform, statusDir, now: () => now + 5_000 }), { host: "127.0.0.1", port });
