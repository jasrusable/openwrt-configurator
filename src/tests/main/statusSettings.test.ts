// A status read loads and compiles the settings again only when the file
// changed, and works out a device's state again only when its facts did.
import test from "ava";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { deviceSchemaSchema } from "../../deviceSchema";
import { writeFacts } from "../../deviceFacts";
import { nodePlatform } from "../../platforms/node";
import { readStatusSettings } from "../../status/read";
import { sampleIntentText, repoRoot } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";

const schemaOf = (model: string) =>
  deviceSchemaSchema.parse(JSON.parse(readFileSync(join(repoRoot, "deviceSchemas", `${model}.json`), "utf8")));

test("the settings are loaded again only when the file changes, a device's state only when its facts do", async (t) => {
  const path = join(tempDir("status-settings"), "intent.json");
  writeFileSync(path, sampleIntentText(), { mode: 0o600 });
  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 1, schema: schemaOf("friendlyarm,nanopi-r6s") });
  let reads = 0;
  const platform = { ...nodePlatform, readTextFile: (p: string) => (p === path && reads++, nodePlatform.readTextFile(p)) };
  const settings = async () => {
    const read = await readStatusSettings(path, platform);
    if (!read.ok) throw new Error(read.error.message);
    return read.value;
  };

  const first = await settings();
  const loads = reads;
  const router = first.expected("home-router");
  t.true(router.mustRun.includes("dnsmasq"), "the router's own services must run");

  const again = await settings();
  t.is(reads - loads, 1, "unchanged: the file is read to compare, not loaded again");
  t.is(again.expected("home-router"), router, "and the device's state is the one worked out before");

  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 2, schema: schemaOf("ubnt,edgerouter-x") });
  t.not((await settings()).expected("home-router"), router, "other facts: worked out again");

  writeFileSync(path, sampleIntentText().replace('"home-router"', '"gateway"'), { mode: 0o600 });
  const renamed = await settings();
  t.deepEqual(renamed.ready.map((d) => d.hostname).sort(), ["gateway", "home-ap-1"], "a changed file: loaded again");
});
