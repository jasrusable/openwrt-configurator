// System › Backup (src/backup.ts, src/server/api/backup.ts): the file
// downloaded as stored; a backup, the defaults or a new network reviewed
// (migrated, checked, its changes listed; `$secret` refs refused) and
// only then written over the very file reviewed, the replaced file kept as a
// timestamped .bak (the last five). And the migration chain, with a fake
// one: oldest to newest a step at a time, newer refused.
import test from "ava";
import { readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { migrate } from "../../intent/migrations";
import { intentVersion } from "../../intent/schema";
import { nodePlatform } from "../../platforms/node";
import { uiHandler } from "../../server/app";
import { backupFileName } from "../../backup";
import { backupPath, backupsOf, keptBackups, readIntentFile, writeIntentFile } from "../../settings";
import { loadConfig } from "../../loadConfig";
import { sampleIntentJson, sampleIntentText } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const request = (method: string, path: string, body = "", headers: Record<string, string> = {}) => ({
  method,
  path,
  body,
  headers: { "x-onc": "1", ...headers },
});

/** A server over a sample intent, or none. */
const serve = ({ saved = sampleIntentText() }: { saved?: string | null } = {}) => {
  const dir = tempDir("backup");
  const intentPath = join(dir, "intent.json");
  if (saved !== null) writeFileSync(intentPath, saved, { mode: 0o600 });
  // A minute on per request: each replaced file gets a time of its own.
  let clock = Date.parse("2026-10-13T12:00:00Z");
  const handle = uiHandler({ intentPath, uiRoot: dir, platform: nodePlatform, now: () => (clock += 60_000) });
  const post = async (path: string, input: unknown, headers: Record<string, string> = {}) => {
    const response = await handle(request("POST", path, JSON.stringify(input), headers));
    return { status: response.status, body: JSON.parse(response.body), headers: response.headers };
  };
  const backups = () => backupsOf(nodePlatform, intentPath);
  return { dir, intentPath, handle, post, backups, saved: () => JSON.parse(readFileSync(intentPath, "utf8")) };
};

const withName = (name: string, extra: Record<string, unknown> = {}) => {
  const intent = sampleIntentJson();
  return JSON.stringify({ ...intent, system: { ...intent.system, name, ...extra } });
};

test("the chain upgrades a step at a time, says where it started, and refuses a newer file", (t) => {
  const chain = { 1: (old: any) => ({ ...old, schema: 2, two: true }), 2: (old: any) => ({ ...old, schema: 3, three: old.two }) };
  t.deepEqual(migrate({ schema: 1 }, chain, 3), { ok: true, value: { value: { schema: 3, two: true, three: true }, from: 1 } });
  t.deepEqual(migrate({ schema: 3 }, chain, 3), { ok: true, value: { value: { schema: 3 }, from: 3 } });
  t.deepEqual(migrate("not an intent", chain, 3), { ok: true, value: { value: "not an intent" } });
  const newer = migrate({ schema: 4 }, chain, 3);
  t.true(!newer.ok && newer.error.kind === "invalid" && /newer version of this app/.test(newer.error.message));
  // A gap, or a step that does not move exactly one version on, is a bug.
  t.throws(() => migrate({ schema: 2 }, { 1: chain[1] }, 3), { message: /No migration from intent version 2/ });
  // No format there ever was: refused, as a file, never thrown.
  for (const schema of [0, -1, 1.5]) t.like(migrate({ schema }, chain, 3), { ok: false, error: { kind: "invalid" } });
  t.throws(() => migrate({ schema: 1 }, { 1: (old: any) => ({ ...old, schema: 3 }) }, 3), { message: /made version 3, not 2/ });
  t.throws(() => migrate({ schema: 1 }, { 1: (old: any) => old }, 3), { message: /made version 1, not 2/ });
});

test("the download is the file exactly as stored, named for the network and day", async (t) => {
  // As written, not as read: no defaults filled in, its own layout.
  const stored = JSON.stringify(sampleIntentJson());
  const { handle } = serve({ saved: stored });
  const response = await handle(request("GET", "/api/backup"));
  t.is(response.status, 200);
  t.is(response.body, stored);
  t.is(response.headers["content-disposition"], 'attachment; filename="home-settings-2026-10-13.json"');
  t.is(backupFileName("  Café & Bar ", new Date(0)), "caf-bar-settings-1970-01-01.json");
  t.is((await serve({ saved: null }).handle(request("GET", "/api/backup"))).status, 404);
});

test("a backup is reviewed before it is written: what it changes, and nothing written until restored", async (t) => {
  const { post, saved } = serve();
  const backup = withName("Home", { timezone: "Europe/London" });
  const review = await post("/api/backup/review", { source: { from: "file", text: backup } });
  t.is(review.status, 200);
  t.deepEqual(review.body.issues, []);
  t.is(review.body.otherNetwork, undefined);
  t.deepEqual(review.body.changes.map((c: { path: string }) => c.path), ["system.timezone"]);
  t.is(saved().system.timezone, "Europe/Zurich");
});

test("restoring writes the backup, keeps the replaced file as a timestamped .bak, and answers the new file and version", async (t) => {
  const { post, intentPath, saved, backups } = serve();
  const before = readFileSync(intentPath, "utf8");
  const restored = await post("/api/backup/restore", { source: { from: "file", text: withName("Home", { timezone: "Europe/London" }) } });
  t.is(restored.status, 200);
  t.is(saved().system.timezone, "Europe/London");
  t.is(restored.body.intent.system.timezone, "Europe/London");
  t.truthy(restored.headers["x-onc-version"]);
  t.deepEqual(backups().map((p) => p.slice(p.lastIndexOf("/") + 1)), ["intent.20261013T120100.000Z.bak"]);
  t.is(readFileSync(backups()[0], "utf8"), before);
  t.is(statSync(backups()[0]).mode & 0o777, 0o600);
  t.is(statSync(intentPath).mode & 0o777, 0o600);
});

test("replaced files: the last five kept, none for a write that changes nothing, named for any *.bak ignore rule", async (t) => {
  const { post, backups } = serve();
  const timezones = ["Europe/London", "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Madrid", "Europe/Vienna", "Europe/Oslo"];
  for (const timezone of timezones) await post("/api/backup/restore", { source: { from: "file", text: withName("Home", { timezone }) } });
  t.is(backups().length, keptBackups);
  // The newest kept is the one before the last restore; the original (Zurich) is gone, the oldest five of seven.
  t.is(JSON.parse(readFileSync(backups()[keptBackups - 1], "utf8")).system.timezone, "Europe/Vienna");
  // The same settings again: nothing written, nothing kept.
  await post("/api/backup/restore", { source: { from: "file", text: withName("Home", { timezone: "Europe/Oslo" }) } });
  t.is(backups().length, keptBackups);
  t.is(JSON.parse(readFileSync(backups()[keptBackups - 1], "utf8")).system.timezone, "Europe/Vienna");
  t.regex(backupPath("/a/b/home.json", Date.parse("2026-10-15T08:09:10.123Z")), /^\/a\/b\/home\.20261015T080910\.123Z\.bak$/);
});

test("a restore is of the file reviewed: the review says its version, and another is refused, saying so", async (t) => {
  const { post, intentPath, saved } = serve();
  const source = { from: "file", text: withName("Home", { timezone: "Europe/London" }) };
  const review = await post("/api/backup/review", { source });
  const version = review.headers["x-onc-version"];
  t.regex(version, /^[0-9a-f]{64}$/);
  // Changed elsewhere since the review.
  writeFileSync(intentPath, withName("Home", { timezone: "Europe/Paris" }), { mode: 0o600 });
  const stale = await post("/api/backup/restore", { source }, { "x-onc-version": version });
  t.is(stale.status, 409);
  t.true(stale.body.changedElsewhere);
  t.is(saved().system.timezone, "Europe/Paris");
  const again = await post("/api/backup/review", { source });
  t.is((await post("/api/backup/restore", { source }, { "x-onc-version": again.headers["x-onc-version"] })).status, 200);
  t.is(saved().system.timezone, "Europe/London");
});

test("a write that fails is a problem that says so, not a throw", (t) => {
  const missing = join(tempDir("backup"), "no-such-dir", "intent.json");
  const written = writeIntentFile(nodePlatform, missing, sampleIntentJson(), { keepOld: "always", at: 0 });
  t.false(written.ok);
  if (!written.ok) t.is(written.error.kind, "internal");
  if (!written.ok) t.regex(written.error.message, /could not be saved/);
});

test("another network's backup is named; a newer one, not JSON, or not settings is refused with why", async (t) => {
  const { post } = serve();
  t.is((await post("/api/backup/review", { source: { from: "file", text: withName("Cabin") } })).body.otherNetwork, "Cabin");
  // Renamed, the same network: its site id says so.
  t.is((await post("/api/backup/review", { source: { from: "file", text: withName("Renamed", { site_id: "Home" }) } })).body.otherNetwork, undefined);
  const newer = await post("/api/backup/review", { source: { from: "file", text: JSON.stringify({ schema: intentVersion + 1 }) } });
  t.is(newer.status, 400);
  t.regex(newer.body.error, /newer version/);
  t.regex((await post("/api/backup/review", { source: { from: "file", text: "{ nope" } })).body.error, /not JSON/);
  t.regex((await post("/api/backup/review", { source: { from: "file", text: "{}" } })).body.error, /not a settings backup/);
});

test("invalid settings are listed at their paths and never written", async (t) => {
  const { post, saved } = serve();
  const broken = JSON.stringify({ ...sampleIntentJson(), networks: [] });
  const review = await post("/api/backup/review", { source: { from: "file", text: broken } });
  t.true(review.body.issues.some((i: { path: string }) => i.path === "networks"));
  const restored = await post("/api/backup/restore", { source: { from: "file", text: broken } });
  t.is(restored.status, 400);
  t.true(restored.body.review.issues.length > 0);
  t.is(saved().networks.length, sampleIntentJson().networks.length);
});

test("an intent holds plain values: one with `$secret` refs is refused on restore, on read and at load, saying why", async (t) => {
  const intent = sampleIntentJson();
  const withRef = JSON.stringify({ ...intent, system: { ...intent.system, app_login: { ...intent.system.app_login, password: { $secret: "root" } } } });
  const { post, handle, intentPath, saved } = serve();
  for (const path of ["/api/backup/review", "/api/backup/restore"]) {
    const refused = await post(path, { source: { from: "file", text: withRef } });
    t.is(refused.status, 400);
    t.regex(refused.body.error, /only supported in low-level config files/);
  }
  t.is(saved().system.app_login.password, intent.system.app_login.password);
  writeFileSync(intentPath, withRef, { mode: 0o600 });
  const read = await handle(request("GET", "/api/intent"));
  t.is(read.status, 409);
  t.regex(JSON.parse(read.body).error, /only supported in low-level config files/);
  const loaded = await loadConfig({ path: intentPath, platform: nodePlatform, lookup: async () => "never-asked" });
  t.false(loaded.ok);
  if (!loaded.ok) t.regex(loaded.error.message, /only supported in low-level config files/);
  // A file that does not read can still be replaced by a backup: that is what restoring is for.
  t.is((await post("/api/backup/restore", { source: { from: "file", text: JSON.stringify(intent) } })).status, 200);
});

test("reset to defaults keeps the network, its devices, where they are and the app's login; the rest is defaults", async (t) => {
  const sample = sampleIntentJson();
  const main = sample.networks.findIndex((n: { vlan?: number }) => n.vlan === undefined);
  const prefix = sample.networks[main].subnet.split(".").slice(0, 3).join(".");
  const reservation = { name: "printer", mac: "aa:bb:cc:dd:ee:01", address: `${prefix}.20` };
  sample.networks[main] = { ...sample.networks[main], dhcp: { ...sample.networks[main].dhcp, reservations: [reservation] } };
  const { post, saved } = serve({ saved: JSON.stringify(sample) });
  const review = await post("/api/backup/review", { source: { from: "defaults" } });
  t.is(review.status, 200);
  t.deepEqual(review.body.issues, []);
  t.true(review.body.changes.length > 0);
  const restored = await post("/api/backup/restore", { source: { from: "defaults" } });
  t.is(restored.status, 200);
  const before = sampleIntentJson();
  const after = saved();
  t.is(after.system.name, before.system.name);
  t.is(after.system.site_id, before.system.site_id);
  t.deepEqual(after.system.app_login, before.system.app_login);
  t.deepEqual(after.hardware.map((d: { name: string; role: string }) => [d.name, d.role]), before.hardware.map((d: { name: string; role: string }) => [d.name, d.role]));
  t.deepEqual(after.networks.map((n: { subnet: string }) => n.subnet), [before.networks[0].subnet]);
  // The main network's reservations are where its devices are: kept.
  t.deepEqual(after.networks[0].dhcp.reservations, [reservation]);
  // No site id made up: the name stays the seed, so no derived id changes.
  t.is(after.system.site_id, undefined);
  t.deepEqual(after.wifi.networks, []);
  t.deepEqual([after.firewall.rules, after.firewall.port_forwards], [[], []]);
});

test("with nothing saved: a new network or a backup can be written; a new one over saved settings is refused", async (t) => {
  const fresh = serve({ saved: null });
  const choices = { name: "Cabin", country: "CH", timezone: "Europe/Zurich", password: "test-only-pass" };
  // Root's password is asked for, at its setting: a network is never started without one.
  const { password, ...without } = choices;
  const asked = await fresh.post("/api/backup/review", { source: { from: "new", choices: without } });
  t.deepEqual(asked.body.issues.map((i: { path: string }) => i.path), ["system.app_login.password"]);
  t.is((await fresh.post("/api/backup/restore", { source: { from: "new", choices: without } })).status, 400);
  const review = await fresh.post("/api/backup/review", { source: { from: "new", choices } });
  t.deepEqual(review.body, { issues: [], changes: [] });
  t.is((await fresh.post("/api/backup/restore", { source: { from: "new", choices } })).status, 200);
  t.is(fresh.saved().networks[0].subnet, "192.168.1.0/24");
  t.is(fresh.saved().system.app_login.password, password);
  t.deepEqual(fresh.backups(), []);
  // Its own site id: another network named alike is never taken for it.
  const other = serve({ saved: null });
  await other.post("/api/backup/restore", { source: { from: "new", choices } });
  t.regex(fresh.saved().system.site_id, /^[0-9a-f]{16}$/);
  t.not(fresh.saved().system.site_id, other.saved().system.site_id);
  t.is((await fresh.post("/api/backup/review", { source: { from: "file", text: JSON.stringify(other.saved()) } })).body.otherNetwork, "Cabin");
  // Any name: the main network has a name of its own.
  const long = serve({ saved: null });
  const longName = "A network name well over thirty-two characters long";
  t.is((await long.post("/api/backup/restore", { source: { from: "new", choices: { ...choices, name: longName } } })).status, 200);
  t.deepEqual([long.saved().system.name, long.saved().networks[0].name], [longName, "Main"]);
  t.is((await serve().post("/api/backup/review", { source: { from: "new", choices } })).status, 409);
  const restoredFirst = serve({ saved: null });
  t.is((await restoredFirst.post("/api/backup/restore", { source: { from: "file", text: sampleIntentText() } })).status, 200);
});

test("with nothing saved, a first write names that: two pages starting at once, only one writes", async (t) => {
  const { post, saved } = serve({ saved: null });
  const review = await post("/api/backup/review", { source: { from: "file", text: sampleIntentText() } });
  t.is(review.headers["x-onc-version"], "", "the version of nothing saved");
  const choices = { name: "Cabin", country: "CH", timezone: "Europe/Zurich", password: "test-only-pass" };
  t.is((await post("/api/backup/restore", { source: { from: "new", choices } }, { "x-onc-version": "" })).status, 200);
  const second = await post("/api/backup/restore", { source: { from: "file", text: sampleIntentText() } }, { "x-onc-version": "" });
  t.is(second.status, 409);
  t.true(second.body.changedElsewhere);
  t.is(saved().system.name, "Cabin");
});

test("a save over a file in an older format keeps it as .bak; a save over a current one does not", async (t) => {
  const { handle, intentPath, backups } = serve();
  const intent = sampleIntentJson();
  t.is((await handle(request("PUT", "/api/intent", JSON.stringify(intent)))).status, 200);
  t.deepEqual(backups(), []);
  // An older format on disk: what a migration would have read.
  writeFileSync(intentPath, JSON.stringify({ ...intent, schema: 0 }), { mode: 0o600 });
  const older = readFileSync(intentPath, "utf8");
  t.true(writeIntentFile(nodePlatform, intentPath, intent, { keepOld: "older-format", at: 0 }).ok);
  t.is(readFileSync(backups()[0], "utf8"), older);
});

test("saved settings that do not read can be downloaded and replaced: by a backup or a new network, the file kept", async (t) => {
  const broken = '{ "schema": 1, "system": ';
  const { handle, post, backups, saved } = serve({ saved: broken });
  t.is((await handle(request("GET", "/api/intent"))).status, 409);
  t.is((await handle(request("GET", "/api/backup"))).body, broken);
  // Nothing in it to keep: no reset.
  t.is((await post("/api/backup/review", { source: { from: "defaults" } })).status, 409);
  const choices = { name: "Cabin", country: "CH", timezone: "Europe/Zurich", password: "test-only-pass" };
  t.is((await post("/api/backup/restore", { source: { from: "new", choices } })).status, 200);
  t.is(saved().system.name, "Cabin");
  t.is(readFileSync(backups()[0], "utf8"), broken);
  // Once it reads, a new network over it is refused.
  t.is((await post("/api/backup/review", { source: { from: "new", choices } })).status, 409);
});

test("a saved file failing only a check across settings reads with its defaults", (t) => {
  const intentPath = join(tempDir("backup"), "intent.json");
  // The sample as stored (Wi-Fi without its defaults), with no root password.
  const sample = sampleIntentJson() as any;
  const { password: _, ...login } = sample.system.app_login;
  const sparse = { ...sample, system: { ...sample.system, app_login: login } };
  writeFileSync(intentPath, JSON.stringify(sparse));
  const read = readIntentFile(nodePlatform, intentPath);
  t.true(read.ok);
  t.truthy((read.ok ? (read.value as any) : undefined)?.wifi?.roaming, "an editor never meets a missing default");
});
