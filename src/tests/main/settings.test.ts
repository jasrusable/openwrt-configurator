// The saved settings load one way everywhere (src/settings.ts), and a load
// that fails says what failed, of the kind it is.
import test from "ava";
import { chmodSync, writeFileSync } from "fs";
import { join } from "path";
import { nodePlatform } from "../../platforms/node";
import { loadSettings } from "../../settings";
import { sampleIntentText } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const saved = (text: string, mode = 0o600) => {
  const path = join(tempDir("settings"), "intent.json");
  writeFileSync(path, text);
  chmodSync(path, mode);
  return path;
};

const failure = async (path: string) => {
  const loaded = await loadSettings(path, nodePlatform);
  return loaded.ok ? undefined : loaded.error;
};

test("the saved intent loads, compiled", async (t) => {
  const loaded = await loadSettings(saved(sampleIntentText()), nodePlatform);
  t.true(loaded.ok);
  if (loaded.ok) t.true(loaded.value.plan.devices.length > 0);
});

test("a load that fails says why, by kind: none saved, unreadable, not valid, not an intent", async (t) => {
  t.like(await failure(join(tempDir("settings"), "missing.json")), { kind: "not-found" });
  if (process.getuid?.() !== 0) {
    const unreadable = await failure(saved(sampleIntentText(), 0o000));
    t.is(unreadable?.kind, "internal", "this machine's failure, not a device's");
    t.regex(unreadable?.message ?? "", /cannot be read/);
  }
  const broken = await failure(saved("{ not json"));
  t.is(broken?.kind, "conflict");
  t.regex(broken?.message ?? "", /not valid/);
  t.like(await failure(saved(JSON.stringify({ devices: [], config: {} }))), { kind: "conflict", message: "The saved settings are not an intent file." });
});
