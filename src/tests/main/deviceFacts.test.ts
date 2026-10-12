import test from "ava";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  factsMaxAgeMs,
  readFacts,
  readFailures,
  refreshStale,
  retryAfterMs,
  staleDevices,
  writeFacts,
} from "../../deviceFacts";
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

test("stale: never read, or older than a day; not one that failed a moment ago", (t) => {
  const now = 10 * factsMaxAgeMs;
  const fresh = { hostname: "a", readAt: now - 1000, schema };
  const old = { hostname: "b", readAt: now - factsMaxAgeMs - 1, schema };
  t.deepEqual(
    staleDevices({
      facts: { fresh: fresh, old: old, never: undefined, failedNow: undefined, failedLong: undefined },
      failures: {
        failedNow: { at: now - 1000, error: "x" },
        failedLong: { at: now - retryAfterMs - 1, error: "x" },
      },
      now,
    }),
    ["old", "never", "failedLong"]
  );
});

test("a device that cannot be reached keeps its facts, says why, and rests before a retry", async (t) => {
  const path = intentFile();
  const old = { hostname: "home-router", readAt: 1, schema };
  writeFacts(nodePlatform, path, old);
  let attempts = 0;
  const offline = {
    ...nodePlatform,
    connect: async () => {
      attempts++;
      throw new Error("connect ECONNREFUSED");
    },
  };
  const now = factsMaxAgeMs + 5000;
  await refreshStale({ intentPath: path, platform: offline, now: () => now });
  t.is(attempts, 2, "both devices were stale");
  t.deepEqual(readFacts(nodePlatform, path, ["home-router"])["home-router"], old);
  t.deepEqual(readFailures(nodePlatform, path, ["home-ap-1"])["home-ap-1"], {
    at: now,
    error: "home-ap-1.lan (where your settings put it): connect ECONNREFUSED",
  });
  await refreshStale({ intentPath: path, platform: offline, now: () => now + 1000 });
  t.is(attempts, 2, "not tried again so soon");
});

test("facts in an older format are read again, but keep where the device is and its key", (t) => {
  const path = intentFile();
  writeFacts(nodePlatform, path, { hostname: "home-ap-1", readAt: 5, schema, address: "10.0.0.9", hostKey: { type: "ssh-ed25519", key: "K" } });
  t.is(readFacts(nodePlatform, path, ["home-ap-1"])["home-ap-1"]?.readAt, 5);
  const file = `${path}.state/devices/home-ap-1.json`;
  const { format: _, ...older } = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify(older));
  t.like(readFacts(nodePlatform, path, ["home-ap-1"])["home-ap-1"], {
    readAt: 0,
    address: "10.0.0.9",
    hostKey: { type: "ssh-ed25519", key: "K" },
  });
});
