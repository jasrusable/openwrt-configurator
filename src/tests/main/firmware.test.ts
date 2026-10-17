// System › Firmware: which release each device should run (a series names
// its newest, never the next series's; a device holds or pins its own; never
// moved back), what OpenWrt has out (ASU's overview, asked once a day, the
// last answer kept offline), and the settings' own checks.
import test from "ava";
import { join } from "path";
import { firmwareRows, newerSeries, Releases, targetOf, updatesAvailable } from "../../firmware/target";
import { asuOverviewUrl, parseOverview, readReleases } from "../../firmware/releases";
import { upgradeFirst } from "../../firmware/run";
import { writeFacts } from "../../deviceFacts";
import { writeFileSync } from "fs";
import { intentSchema } from "../../intent/schema";
import { nodePlatform } from "../../platforms/node";
import { runCollector } from "../../status/collector";
import { ok } from "../../result";
import { whereIs } from "../../../ui/src/settingPages";
import { uncheckedSeries } from "../../release";
import { upgradePlan } from "../../firmware/upgradePlan";
import { compileIntent } from "../../intent/compile";
import { capturedBoards } from "../helpers/capturedBoards";
import { readRepoJson, sampleIntent, sampleIntentJson } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const overview = JSON.stringify(readRepoJson("src", "tests", "helpers", "firmware", "asu-overview.json"));
const releases: Releases = { at: 1, series: { "25.12": ["25.12.5", "25.12.4", "25.12.3"], "26.1": ["26.1.0"] } };

const withFirmware = (release?: string, devices: Record<string, string> = {}) => {
  const intent = sampleIntent();
  return {
    ...intent,
    system: { ...intent.system, ...(release ? { firmware: { release } } : {}) },
    hardware: intent.hardware.map((d) => (devices[d.name] ? { ...d, firmware: devices[d.name] as "hold" } : d)),
  };
};

test("ASU's overview reads as the supported series' stable releases, newest first", (t) => {
  const read = parseOverview(overview, 42)!;
  t.is(read.at, 42);
  // 24.10 and older have opkg; SNAPSHOT is no series to follow; candidates and branch snapshots are not releases.
  t.deepEqual(Object.keys(read.series), ["25.12"]);
  t.deepEqual(read.series["25.12"], ["25.12.5", "25.12.4", "25.12.3", "25.12.2", "25.12.1", "25.12.0"]);
  t.is(parseOverview("<html>busy</html>", 1), undefined);
});

test("a series follows its newest release and never the next series; one release stays put", (t) => {
  const [router, ap] = sampleIntent().hardware.map((d) => d.name);
  t.deepEqual(targetOf(withFirmware(), router, releases), { kind: "release", version: "25.12.5", pinned: false });
  t.deepEqual(targetOf(withFirmware("25.12.4"), router, releases), { kind: "release", version: "25.12.4", pinned: false });
  t.deepEqual(targetOf(withFirmware("26.1"), router, releases), { kind: "release", version: "26.1.0", pinned: false });
  // Not read yet: said, not guessed.
  t.deepEqual(targetOf(withFirmware(), router), { kind: "unknown", series: "25.12" });
  t.deepEqual(newerSeries(withFirmware(), releases), ["26.1"]);
  t.deepEqual(newerSeries(withFirmware("26.1"), releases), []);
  const own = withFirmware(undefined, { [router]: "hold", [ap]: "25.12.3" });
  t.deepEqual(targetOf(own, router, releases), { kind: "hold" });
  t.deepEqual(targetOf(own, ap, releases), { kind: "release", version: "25.12.3", pinned: true });
});

test("each device stands against what it runs: an update, current, held, unread, or a downgrade", (t) => {
  const [router, ap] = sampleIntent().hardware.map((d) => d.name);
  const rows = (intent: ReturnType<typeof withFirmware>, facts: Record<string, string>) =>
    firmwareRows({ intent, facts: Object.fromEntries(Object.entries(facts).map(([n, version]) => [n, { version }])), releases }).map(
      (r) => r.state
    );
  t.deepEqual(rows(withFirmware(), { [router]: "25.12.3", [ap]: "25.12.5" }), ["update", "current"]);
  t.deepEqual(rows(withFirmware("25.12.4"), { [router]: "25.12.5" }), ["downgrade", "not-read"]);
  t.deepEqual(rows(withFirmware(undefined, { [router]: "hold" }), { [router]: "25.12.0" }), ["held", "not-read"]);
  t.deepEqual(rows(withFirmware(undefined, { [ap]: "hold" }), {}), ["not-read", "held"]);
  const rowsOf = (facts: Record<string, string>, intent = withFirmware()) =>
    firmwareRows({ intent, facts: Object.fromEntries(Object.entries(facts).map(([n, version]) => [n, { version }])), releases });
  // Every dot says this: the newest release some device can move up to, which devices, in words.
  t.deepEqual(updatesAvailable(rowsOf({ [router]: "25.12.3", [ap]: "25.12.4" }), releases), {
    version: "25.12.5",
    devices: [router, ap],
    text: "OpenWrt 25.12.5 is out: 2 devices can update.",
  });
  t.is(updatesAvailable(rowsOf({ [router]: "25.12.3" }), undefined), undefined, "no dot before the releases were ever read");
  t.is(updatesAvailable(rowsOf({ [router]: "25.12.5", [ap]: "25.12.5" }), releases), undefined, "none when all are up to date");
  t.is(updatesAvailable(rowsOf({ [router]: "25.12.3" }, withFirmware(undefined, { [router]: "hold" })), releases), undefined, "a held device is no update");
  t.is(updatesAvailable(rowsOf({ [router]: "25.12.5" }, withFirmware("25.12.4")), releases), undefined, "a downgrade is no update");
  t.is(updatesAvailable(rowsOf({ [router]: "25.12.3" }), releases)?.text, "OpenWrt 25.12.5 is out: 1 device can update.");
});

test("the settings take a series or a release from 25.12 on; a device holds or pins a release", (t) => {
  const json = sampleIntentJson();
  const parse = (system: object, device: object = {}) =>
    intentSchema.safeParse({
      ...json,
      system: { ...json.system, ...system },
      hardware: json.hardware.map((d: object, i: number) => (i === 0 ? { ...d, ...device } : d)),
    }).success;
  t.true(parse({ firmware: { release: "25.12" } }));
  t.true(parse({ firmware: { release: "25.12.5" } }));
  t.true(parse({ firmware: {} }));
  t.false(parse({ firmware: { release: "24.10" } }), "older releases have opkg");
  t.false(parse({ firmware: { release: "latest" } }));
  t.true(parse({}, { firmware: "hold" }));
  t.true(parse({}, { firmware: "25.12.3" }));
  t.false(parse({}, { firmware: "25.12" }), "a device pins a release, not a series");
  t.false(parse({}, { firmware: "24.10.8" }));
});

test("a device's firmware is set in the Firmware tab", (t) => {
  t.deepEqual(whereIs("hardware.1.firmware"), { page: "system", url: "/settings/system/firmware" });
  t.deepEqual(whereIs("system.firmware.release"), { page: "system", url: "/settings/system/firmware" });
  t.deepEqual(whereIs("hardware.1.name"), { page: "hardware", url: "/settings/hardware/1" });
});

/** A platform whose HTTP answers `answer`, counting the asks. */
const httpOf = (answer: () => Promise<{ status: number; body: string }>) => {
  const asked = { count: 0 };
  return {
    asked,
    platform: {
      ...nodePlatform,
      http: {
        ...nodePlatform.http,
        request: async () => {
          asked.count++;
          return { ...(await answer()), headers: {} };
        },
      },
    },
  };
};

test("releases are asked at most once a day, and offline the last answer stands with why", async (t) => {
  const intentPath = join(tempDir("firmware"), "intent.json");
  let online = true;
  const { asked, platform } = httpOf(async () => {
    if (!online) throw Object.assign(new Error("Could not resolve host"), { transient: true });
    return { status: 200, body: overview };
  });
  const first = await readReleases({ intentPath, platform, now: () => 1000 });
  t.is(first.releases?.series["25.12"][0], "25.12.5");
  t.is(asked.count, 1);
  // Kept: an hour later nothing is asked.
  await readReleases({ intentPath, platform, now: () => 1000 + 3_600_000 });
  t.is(asked.count, 1);
  // A day later it is asked again; offline, the last answer stands, saying why.
  online = false;
  const offline = await readReleases({ intentPath, platform, now: () => 1000 + 25 * 3_600_000 });
  t.is(asked.count, 2);
  t.is(offline.releases?.at, 1000);
  t.regex(offline.error!, /Could not ask OpenWrt: Could not resolve host/);
});

test("the collector asks once an hour beside its reads", async (t) => {
  const dir = tempDir("firmware-collector");
  let clock = 0;
  let asks = 0;
  await runCollector({
    intentPath: join(dir, "missing.json"),
    platform: { ...nodePlatform, sleep: async () => void (clock += 60_000) },
    dir,
    now: () => clock,
    stop: () => clock >= 3 * 3_600_000,
    collect: async ({ state }) => ok(state),
    everyHour: async () => {
      asks++;
      throw new Error("a failed ask is the next hour's");
    },
  });
  t.is(asks, 3);
});

test("Latest OpenWrt follows the newest stable release of any series; a series its own; one release stays; candidates never count", (t) => {
  const [router] = sampleIntent().hardware.map((d) => d.name);
  const out: Releases = { at: 1, series: { "25.12": ["25.12.5", "25.12.4"], "26.1": ["26.1.0"] } };
  t.deepEqual(targetOf(withFirmware("stable"), router, out), { kind: "release", version: "26.1.0", pinned: false });
  t.deepEqual(targetOf(withFirmware("25.12"), router, out), { kind: "release", version: "25.12.5", pinned: false });
  t.deepEqual(targetOf(withFirmware("25.12.4"), router, out), { kind: "release", version: "25.12.4", pinned: false });
  t.deepEqual(newerSeries(withFirmware("stable"), out), [], "Latest OpenWrt already follows a new series");
  // A series out only as release candidates is no release yet: Latest OpenWrt stays where it is.
  const candidates = JSON.parse(overview);
  candidates.branches["26.1"] = { name: "26.1", enabled: true, snapshot: false, versions: ["26.1.0-rc2", "26.1.0-rc1", "26.1-SNAPSHOT"] };
  const read = parseOverview(JSON.stringify(candidates), 1)!;
  t.false("26.1" in read.series);
  t.deepEqual(targetOf(withFirmware("stable"), router, read), { kind: "release", version: "25.12.5", pinned: false });
  t.deepEqual(targetOf(withFirmware("stable"), router), { kind: "unknown", series: "stable" });
  t.true(intentSchema.safeParse({ ...sampleIntentJson(), system: { ...sampleIntentJson().system, firmware: { release: "stable" } } }).success);
});

test("a series newer than this app has been checked against is said, and must be acknowledged before an upgrade into it", (t) => {
  t.false(uncheckedSeries("25.12.5"));
  t.true(uncheckedSeries("26.1.0"));
  const intent = withFirmware("stable");
  const out: Releases = { at: 1, series: { "25.12": ["25.12.5"], "26.1": ["26.1.0"] } };
  const facts = Object.fromEntries(intent.hardware.map((d) => [d.name, { ...capturedBoards()[0].schema, version: "25.12.5", target: "rockchip/armv8" }]));
  const plan = upgradePlan({ intent, plan: compileIntent(intent), facts, releases: out, sha256: nodePlatform.sha256 });
  t.deepEqual(plan.newSeries, ["26.1"]);
  t.deepEqual(upgradePlan({ intent: withFirmware("25.12"), plan: compileIntent(intent), facts, releases: out, sha256: nodePlatform.sha256 }).newSeries, []);
});

test("an upgrade into a new series is refused before anything is built or flashed, unless acknowledged", async (t) => {
  const intentPath = join(tempDir("new-series"), "intent.json");
  const intent = withFirmware("stable");
  writeFileSync(intentPath, JSON.stringify(intent), { mode: 0o600 });
  for (const d of intent.hardware) {
    writeFacts(nodePlatform, intentPath, { hostname: d.name, readAt: Date.now(), schema: { ...capturedBoards()[0].schema, version: "25.12.5", target: "rockchip/armv8" } });
  }
  const asked: string[] = [];
  const platform = {
    ...nodePlatform,
    // No device answers: none is this machine, and none is touched.
    connect: async () => {
      throw new Error("no route");
    },
    http: {
      ...nodePlatform.http,
      request: async ({ url }: { url: string }) => {
        asked.push(url);
        const branches = { "25.12": { versions: ["25.12.5"] }, "26.1": { versions: ["26.1.0"] } };
        return { status: 200, headers: {}, body: JSON.stringify({ branches }) };
      },
    },
  };
  const run = (acceptNewSeries: boolean) =>
    upgradeFirst({ intentPath, intent, plan: compileIntent(intent), runId: "r", platform, report: () => {}, log: () => {}, acceptNewSeries });
  const refused = await run(false);
  t.regex(!refused.ok ? refused.error.message : "", /^Nothing was flashed: OpenWrt 26\.1 is a new series, not yet checked by this app/);
  t.deepEqual(asked, [asuOverviewUrl], "only the releases were asked: nothing was built");
  // Acknowledged: past the guard, on to the builds (which this stand-in cannot make).
  const accepted = await run(true);
  t.regex(!accepted.ok ? accepted.error.message : "", /^Nothing was flashed: images could not be built\. .*OpenWrt 26\.1\.0's rockchip\/armv8 profiles could not be read\./);
  t.true(asked.some((url) => url.endsWith("/profiles.json")));
});

test("a downgrade is refused before anything is built or flashed, unless acknowledged", async (t) => {
  const intentPath = join(tempDir("downgrade"), "intent.json");
  const json = sampleIntentJson();
  const intent = withFirmware(undefined, { [json.hardware[0].name]: "25.12.3" });
  writeFileSync(intentPath, JSON.stringify(intent), { mode: 0o600 });
  for (const d of intent.hardware) {
    writeFacts(nodePlatform, intentPath, { hostname: d.name, readAt: Date.now(), schema: { ...capturedBoards()[0].schema, version: "25.12.5", target: "rockchip/armv8" } });
  }
  const platform = {
    ...nodePlatform,
    connect: async () => {
      throw new Error("no route");
    },
    http: {
      ...nodePlatform.http,
      request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ branches: { "25.12": { versions: ["25.12.5", "25.12.3"] } } }) }),
    },
  };
  const run = (acceptDowngrade: boolean) =>
    upgradeFirst({ intentPath, intent, plan: compileIntent(intent), runId: "r", platform, report: () => {}, log: () => {}, acceptDowngrade });
  const refused = await run(false);
  t.regex(!refused.ok ? refused.error.message : "", /^Nothing was flashed: home-router would go back from 25\.12\.5 to 25\.12\.3\. Acknowledge the downgrade/);
  const accepted = await run(true);
  t.regex(!accepted.ok ? accepted.error.message : "", /could not be built/, "past the guard, on to the builds");
});
