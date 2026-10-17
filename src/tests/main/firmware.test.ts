// System › Firmware: which release each device should run (a series names
// its newest, never the next series's; a device holds or pins its own; never
// moved back), what OpenWrt has out (ASU's overview, asked once a day, the
// last answer kept offline), and the settings' own checks.
import test from "ava";
import { join } from "path";
import { firmwareRows, isFirmwareChoice, newerSeries, Releases, targetOf, updatesAvailable } from "../../firmware/target";
import { jobPaths } from "../../apply/job";
import { diffIntent } from "../../intent/diff";
import { uiHandler } from "../../server/app";
import { asuOverviewUrl, parseOverview, readReleases } from "../../firmware/releases";
import { planAfterUpgrade, stationsOf, upgradeFirst } from "../../firmware/run";
import { writeFacts } from "../../deviceFacts";
import { writeFileSync } from "fs";
import { Intent, intentSchema } from "../../intent/schema";
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

/** An authorized key, this app's own: no image is built without it. */
const key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7cL9mXJ8uH2n0u5bq1nE2b6p0Gx3m5qS1qR8u0Vtq you@mac";
const appKeyPath = join(tempDir("app-key"), "id_ed25519");
writeFileSync(`${appKeyPath}.pub`, `${key}\n`);

const withFirmware = (release?: string, devices: Record<string, string> = {}) => {
  const intent = sampleIntent();
  return {
    ...intent,
    system: {
      ...intent.system,
      app_login: { key: appKeyPath },
      ssh: { authorized_keys: [key], password_login: false },
      ...(release ? { firmware: { release } } : {}),
    },
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
  t.deepEqual(targetOf(withFirmware(), router, releases), { kind: "release", version: "25.12.5", pinned: false, follows: "25.12" });
  t.deepEqual(targetOf(withFirmware("25.12.4"), router, releases), { kind: "release", version: "25.12.4", pinned: false });
  t.deepEqual(targetOf(withFirmware("26.1"), router, releases), { kind: "release", version: "26.1.0", pinned: false, follows: "26.1" });
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
  // Ahead of the newest read of what it follows (releases read before, or moved by hand): current, never moved back.
  t.deepEqual(rows(withFirmware(), { [router]: "25.12.6" }), ["current", "not-read"]);
  t.deepEqual(rows(withFirmware("stable"), { [router]: "26.1.1" }), ["current", "not-read"]);
  t.deepEqual(rows(withFirmware(undefined, { [router]: "25.12.4" }), { [router]: "25.12.6" }), ["downgrade", "not-read"], "a pin is a release named for it");
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
  t.deepEqual(targetOf(withFirmware("stable"), router, out), { kind: "release", version: "26.1.0", pinned: false, follows: "stable" });
  t.deepEqual(targetOf(withFirmware("25.12"), router, out), { kind: "release", version: "25.12.5", pinned: false, follows: "25.12" });
  t.deepEqual(targetOf(withFirmware("25.12.4"), router, out), { kind: "release", version: "25.12.4", pinned: false });
  t.deepEqual(newerSeries(withFirmware("stable"), out), [], "Latest OpenWrt already follows a new series");
  // A series out only as release candidates is no release yet: Latest OpenWrt stays where it is.
  const candidates = JSON.parse(overview);
  candidates.branches["26.1"] = { name: "26.1", enabled: true, snapshot: false, versions: ["26.1.0-rc2", "26.1.0-rc1", "26.1-SNAPSHOT"] };
  const read = parseOverview(JSON.stringify(candidates), 1)!;
  t.false("26.1" in read.series);
  t.deepEqual(targetOf(withFirmware("stable"), router, read), { kind: "release", version: "25.12.5", pinned: false, follows: "stable" });
  t.deepEqual(targetOf(withFirmware("stable"), router), { kind: "unknown", series: "stable" });
  t.true(intentSchema.safeParse({ ...sampleIntentJson(), system: { ...sampleIntentJson().system, firmware: { release: "stable" } } }).success);
});

test("a series newer than this app has been checked against is said, and must be acknowledged before an upgrade into it", (t) => {
  t.false(uncheckedSeries("25.12.5"));
  t.true(uncheckedSeries("26.1.0"));
  const intent = withFirmware("stable");
  const out: Releases = { at: 1, series: { "25.12": ["25.12.5"], "26.1": ["26.1.0"] } };
  const facts = Object.fromEntries(intent.hardware.map((d) => [d.name, { ...capturedBoards()[0].schema, version: "25.12.5", target: "rockchip/armv8" }]));
  const plan = upgradePlan({ intent, plan: compileIntent(intent), facts, releases: out, sha256: nodePlatform.sha256, appKey: key });
  t.deepEqual(plan.newSeries, ["26.1"]);
  t.deepEqual(upgradePlan({ intent: withFirmware("25.12"), plan: compileIntent(intent), facts, releases: out, sha256: nodePlatform.sha256, appKey: key }).newSeries, []);
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
  // Acknowledged: past the guard, on to reading the devices (which do not answer here): nothing built.
  const accepted = await run(true);
  t.regex(!accepted.ok ? accepted.error.message : "", /^Nothing was flashed: .*could not be reached/);
  t.false(asked.some((url) => url.endsWith("/profiles.json")));
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
  t.regex(!accepted.ok ? accepted.error.message : "", /could not be reached/, "past the guard, on to reading the devices");
});

test("no upgrade without this app's key authorized: refused before any device is touched or image built, with where to add it", async (t) => {
  const intentPath = join(tempDir("no-key"), "intent.json");
  const keyless = { ...withFirmware(), system: { ...withFirmware().system, ssh: { authorized_keys: [], password_login: true } } };
  const unreadable = { ...withFirmware(), system: { ...withFirmware().system, app_login: { password: "test-only" } } };
  const asked: string[] = [];
  const platform = {
    ...nodePlatform,
    connect: async () => {
      throw new Error("not to be touched");
    },
    http: {
      ...nodePlatform.http,
      request: async ({ url }: { url: string }) => (
        asked.push(url), { status: 200, headers: {}, body: JSON.stringify({ branches: { "25.12": { versions: ["25.12.5", "25.12.3"] } } }) }
      ),
    },
  };
  const said = async (intent: Intent) => {
    writeFileSync(intentPath, JSON.stringify(intent), { mode: 0o600 });
    for (const d of intent.hardware) {
      writeFacts(nodePlatform, intentPath, { hostname: d.name, readAt: Date.now(), schema: { ...capturedBoards()[0].schema, version: "25.12.3", target: "rockchip/armv8" } });
    }
    const refused = await upgradeFirst({ intentPath, intent, plan: compileIntent(intent), runId: "r", platform, report: () => {}, log: () => {} });
    return !refused.ok ? refused.error.message : "";
  };
  t.regex(await said(keyless), /^Nothing was flashed\. home-router, home-ap-1: Add an SSH key first \(System › General › Authorized keys\)/);
  // It logs in with a password: a device fresh from an image would not let it in.
  t.regex(await said(unreadable), /^Nothing was flashed\. home-router, home-ap-1: Give this app an SSH key it can read/);
  t.deepEqual(asked, [asuOverviewUrl], "only the releases asked: nothing built");
});

test("after an upgrade the saved settings go to every device; stopped partway, to those it upgraded, and with none, nowhere", (t) => {
  const plan = compileIntent(withFirmware());
  const names = (p?: { devices: { hostname: string }[] }) => p?.devices.map((d) => d.hostname);
  t.deepEqual(names(planAfterUpgrade(plan, { upgraded: [] })), ["home-router", "home-ap-1"]);
  const stopped = { kind: "failed" as const, message: "home-router: it did not answer" };
  t.deepEqual(names(planAfterUpgrade(plan, { upgraded: ["home-ap-1"], stopped })), ["home-ap-1"]);
  t.is(planAfterUpgrade(plan, { upgraded: [], stopped }), undefined);
});

test("an upgrade from the UI sends nothing unreviewed, and is acknowledged for exactly what it moves", async (t) => {
  const intentPath = join(tempDir("upgrade-api"), "intent.json");
  const [router] = sampleIntent().hardware.map((d) => d.name);
  const pinned = withFirmware(undefined, { [router]: "25.12.3" });
  const saved = { ...pinned, system: { ...pinned.system, app_login: { ...pinned.system.app_login, password: "test-only-pass" } } };
  writeFileSync(intentPath, JSON.stringify(saved), { mode: 0o600 });
  for (const d of saved.hardware) {
    writeFacts(nodePlatform, intentPath, { hostname: d.name, readAt: Date.now(), schema: { ...capturedBoards()[0].schema, version: "25.12.5", target: "rockchip/armv8" } });
  }
  const started: string[][] = [];
  const platform = {
    ...nodePlatform,
    selfCommand: () => ["onc"],
    spawnDetached: (argv: string[]) => (started.push(argv), 4242),
    // No run stays alive: each next request may start one.
    commandLineOf: async () => undefined,
    http: {
      ...nodePlatform.http,
      request: async () => ({ status: 200, headers: {}, body: JSON.stringify({ branches: { "25.12": { versions: ["25.12.5", "25.12.3"] } } }) }),
    },
  };
  const handle = uiHandler({ intentPath, uiRoot: tempDir("upgrade-api-ui"), platform, now: Date.now });
  const upgrade = async (acknowledged: object) => {
    const answer = await handle({ method: "POST", path: "/api/firmware/upgrade", body: JSON.stringify({ devices: [router], acknowledged }), headers: { "x-onc": "1" } });
    return { status: answer.status, error: answer.status === 202 ? "" : String(JSON.parse(answer.body).error) };
  };
  const downgrade = { downgrades: { [router]: "25.12.3" }, newSeries: [] };
  t.regex((await upgrade(downgrade)).error, /^Nothing has been applied from here yet/);
  t.regex((await upgrade({ ...downgrade, downgrades: { [router]: "25.12.4" }, unapplied: true })).error, /has changed since it was acknowledged/, "a tick for another release");
  t.is((await upgrade({ ...downgrade, unapplied: true })).status, 202);
  t.true(started[0].join(" ").includes(`--upgrade ${router} --accept-downgrade`));
  // Applied once: what is live differs from what is saved by more than the firmware choices.
  const live = jobPaths(intentPath).live;
  writeFileSync(live, JSON.stringify({ ...saved, system: { ...saved.system, name: "Before" } }), { mode: 0o600 });
  t.regex((await upgrade(downgrade)).error, /^Saved changes are not applied yet \(.*\): apply them first/);
  // By the firmware choices alone: they reach no device, so nothing goes out unreviewed.
  writeFileSync(live, JSON.stringify({ ...saved, hardware: saved.hardware.map(({ firmware, ...d }) => d) }), { mode: 0o600 });
  t.is((await upgrade(downgrade)).status, 202);
  t.is(started.length, 2);
});

test("only the firmware choices are firmware choices, as the saved changes name them", (t) => {
  const [router] = sampleIntent().hardware.map((d) => d.name);
  const before = withFirmware();
  const paths = diffIntent(before, withFirmware("26.1", { [router]: "25.12.3" })).map((c) => c.path);
  t.true(paths.length >= 2 && paths.every(isFirmwareChoice), paths.join(", "));
  t.false(diffIntent(before, { ...before, system: { ...before.system, name: "Other" } }).map((c) => c.path).some(isFirmwareChoice));
  t.false(isFirmwareChoice("hardware.0"), "a device added is no firmware choice");
});

test("OpenWrt's releases are needed only for a device that follows a series: one named a release upgrades without them", async (t) => {
  const run = async (release: string) => {
    const intentPath = join(tempDir("offline"), "intent.json");
    const intent = withFirmware(release);
    writeFileSync(intentPath, JSON.stringify(intent), { mode: 0o600 });
    for (const d of intent.hardware) {
      writeFacts(nodePlatform, intentPath, { hostname: d.name, readAt: Date.now(), schema: { ...capturedBoards()[0].schema, version: "25.12.3", target: "rockchip/armv8" } });
    }
    const platform = {
      ...nodePlatform,
      connect: async () => {
        throw new Error("no route");
      },
      http: {
        ...nodePlatform.http,
        request: async () => {
          throw new Error("offline");
        },
      },
    };
    const result = await upgradeFirst({ intentPath, intent, plan: compileIntent(intent), runId: "r", platform, report: () => {}, log: () => {} });
    return !result.ok ? result.error.message : "";
  };
  t.regex(await run("25.12"), /offline.*: which release .* should move to is not known/);
  t.regex(await run("25.12.5"), /could not be reached/, "past the releases, on to reading the devices");
});

test("a device whose Wi-Fi clients could not be read is not reached, never one with none: it could strand this machine", async (t) => {
  const answering = (answer: object) => ({ execCommand: async () => ({ stdout: "", stderr: "", code: 0, ...answer }) }) as never;
  t.deepEqual(await stationsOf(answering({ stdout: "AA:BB:CC:DD:EE:01  -40 dBm / -95 dBm (SNR 55)  0 ms ago\n" })), ["aa:bb:cc:dd:ee:01"]);
  t.deepEqual(await stationsOf(answering({})), [], "no Wi-Fi: none");
  await t.throwsAsync(stationsOf(answering({ code: null, timedOut: true })), { message: /could not be read/ });
  await t.throwsAsync(stationsOf(answering({ code: null })), { message: /could not be read/ });
});
