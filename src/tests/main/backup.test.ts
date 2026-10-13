// System › Backup (src/backup.ts, src/server/api/backup.ts): the file
// downloaded as stored; a backup, the defaults or a new network reviewed
// (migrated, checked, its changes listed; `$secret` refs refused) and
// only then written, the replaced file kept as .bak. And the migration
// chain, with a fake one: oldest to newest a step at a time, newer refused.
import test from "ava";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { migrate } from "../../intent/migrations";
import { intentVersion } from "../../intent/schema";
import { nodePlatform } from "../../platforms/node";
import { uiHandler } from "../../server/app";
import { backupFileName } from "../../backup";
import { writeIntentFile } from "../../settings";
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
  const handle = uiHandler({ intentPath, uiRoot: dir, platform: nodePlatform, now: () => Date.parse("2026-10-13T12:00:00Z") });
  const post = async (path: string, input: unknown) => {
    const response = await handle(request("POST", path, JSON.stringify(input)));
    return { status: response.status, body: JSON.parse(response.body), headers: response.headers };
  };
  return { intentPath, handle, post, saved: () => JSON.parse(readFileSync(intentPath, "utf8")) };
};

const withName = (name: string, extra: Record<string, unknown> = {}) => {
  const intent = sampleIntentJson();
  return JSON.stringify({ ...intent, system: { ...intent.system, name, ...extra } });
};

test("the chain upgrades a step at a time, says where it started, and refuses a newer file", (t) => {
  const chain = { 1: (old: any) => ({ ...old, schema: 2, two: true }), 2: (old: any) => ({ ...old, schema: 3, three: old.two }) };
  t.deepEqual(migrate({ schema: 1 }, chain, 3), { value: { schema: 3, two: true, three: true }, from: 1 });
  t.deepEqual(migrate({ schema: 3 }, chain, 3), { value: { schema: 3 }, from: 3 });
  t.deepEqual(migrate("not an intent", chain, 3), { value: "not an intent" });
  t.throws(() => migrate({ schema: 4 }, chain, 3), { message: /newer version of this app/ });
  t.throws(() => migrate({ schema: 0 }, chain, 3), { message: /No migration from intent version 0/ });
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

test("restoring writes the backup, keeps the replaced file as .bak, and answers the new file and version", async (t) => {
  const { post, intentPath, saved } = serve();
  const before = readFileSync(intentPath, "utf8");
  const restored = await post("/api/backup/restore", { source: { from: "file", text: withName("Home", { timezone: "Europe/London" }) } });
  t.is(restored.status, 200);
  t.is(saved().system.timezone, "Europe/London");
  t.is(restored.body.intent.system.timezone, "Europe/London");
  t.truthy(restored.headers["x-onc-version"]);
  t.is(readFileSync(`${intentPath}.bak`, "utf8"), before);
});

test("a restore of a file changed elsewhere since its review is refused", async (t) => {
  const { handle } = serve();
  const body = JSON.stringify({ source: { from: "file", text: withName("Home") } });
  const response = await handle(request("POST", "/api/backup/restore", body, { "x-onc-version": "stale" }));
  t.is(response.status, 409);
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
  const { post, saved } = serve();
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
  t.deepEqual(after.wifi.networks, []);
  t.deepEqual([after.firewall.rules, after.firewall.port_forwards], [[], []]);
});

test("with nothing saved: a new network or a backup can be written; a new one over saved settings is refused", async (t) => {
  const fresh = serve({ saved: null });
  const choices = { name: "Cabin", country: "CH", timezone: "Europe/Zurich" };
  const review = await fresh.post("/api/backup/review", { source: { from: "new", choices } });
  t.deepEqual(review.body, { issues: [], changes: [] });
  t.is((await fresh.post("/api/backup/restore", { source: { from: "new", choices } })).status, 200);
  t.is(fresh.saved().networks[0].subnet, "192.168.1.0/24");
  t.false(existsSync(`${fresh.intentPath}.bak`));
  t.is((await serve().post("/api/backup/review", { source: { from: "new", choices } })).status, 409);
  const restoredFirst = serve({ saved: null });
  t.is((await restoredFirst.post("/api/backup/restore", { source: { from: "file", text: sampleIntentText() } })).status, 200);
});

test("a save over a file in an older format keeps it as .bak; a save over a current one does not", async (t) => {
  const { handle, intentPath } = serve();
  const intent = sampleIntentJson();
  t.is((await handle(request("PUT", "/api/intent", JSON.stringify(intent)))).status, 200);
  t.false(existsSync(`${intentPath}.bak`));
  // An older format on disk: what a migration would have read.
  writeFileSync(intentPath, JSON.stringify({ ...intent, schema: 0 }), { mode: 0o600 });
  const older = readFileSync(intentPath, "utf8");
  writeIntentFile(nodePlatform, intentPath, intent, { keepOld: "older-format" });
  t.is(readFileSync(`${intentPath}.bak`, "utf8"), older);
});
