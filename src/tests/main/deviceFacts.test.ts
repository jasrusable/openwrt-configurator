import test from "ava";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { readDevices, readFacts, writeFacts } from "../../deviceFacts";
import { deviceSchemaSchema } from "../../deviceSchema";
import { nodePlatform } from "../../platforms/node";

const root = join(__dirname, "..", "..", "..");
const schema = deviceSchemaSchema.parse(
  JSON.parse(readFileSync(join(root, "deviceSchemas", "friendlyarm,nanopi-r6s.json"), "utf8"))
);

const intentFile = () => {
  const dir = mkdtempSync(join(tmpdir(), "onc-facts-"));
  const path = join(dir, "intent.json");
  writeFileSync(path, readFileSync(join(root, "sampleConfigs", "intent.json")));
  chmodSync(path, 0o600);
  return path;
};

test("facts are kept beside the intent, per device; one never read has none", (t) => {
  const path = intentFile();
  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 1234, schema });
  const facts = readFacts(nodePlatform, path, ["home-router", "home-ap-1"]);
  t.deepEqual(facts["home-router"], { hostname: "home-router", readAt: 1234, schema });
  t.is(facts["home-ap-1"], undefined);
  t.true(readFileSync(`${path}.state/devices/home-router.json`, "utf8").includes('"readAt": 1234'));
});

test("a file that is not facts reads as none, not an error", (t) => {
  const path = intentFile();
  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 1, schema });
  writeFileSync(`${path}.state/devices/home-router.json`, "{ not json");
  t.is(readFacts(nodePlatform, path, ["home-router"])["home-router"], undefined);
});

test("a device that cannot be reached says why, and keeps the facts it had", async (t) => {
  const path = intentFile();
  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 1, schema });
  const offline = {
    ...nodePlatform,
    connect: async () => {
      throw new Error("connect ECONNREFUSED");
    },
  };
  const results = await readDevices({ intentPath: path, platform: offline });
  t.deepEqual(
    results.map((r) => [r.hostname, r.ok, !r.ok && r.error]),
    [
      ["home-router", false, "connect ECONNREFUSED"],
      ["home-ap-1", false, "connect ECONNREFUSED"],
    ]
  );
  t.is(readFacts(nodePlatform, path, ["home-router"])["home-router"]?.readAt, 1);
});
