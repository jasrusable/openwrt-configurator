import test from "ava";
import { sampleIntentText } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  factsMaxAgeMs,
  listSeen,
  readFacts,
  readFailures,
  retryAfterMs,
  staleDevices,
  writeFacts,
} from "../../deviceFacts";
import { deviceSchemaSchema } from "../../deviceSchema";
import { nodePlatform } from "../../platforms/node";
import { refreshStale } from "../../readEach";
import { board, network } from "../helpers/fakeNetwork";

const root = join(__dirname, "..", "..", "..");
const schema = deviceSchemaSchema.parse(
  JSON.parse(readFileSync(join(root, "deviceSchemas", "friendlyarm,nanopi-r6s.json"), "utf8"))
);

const intentFile = () => {
  const dir = tempDir("facts");
  const path = join(dir, "intent.json");
  writeFileSync(path, sampleIntentText());
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
    env: (name: string) => (name === "ONC_KNOWN_HOSTS" ? `${path}.known_hosts` : undefined),
    connect: async () => {
      attempts++;
      throw new Error("connect ECONNREFUSED");
    },
  };
  const now = factsMaxAgeMs + 5000;
  await refreshStale({ intentPath: path, platform: offline, now: () => now });
  t.is(attempts, 1, "both were stale; the access point's name is not tried without its key");
  t.deepEqual(readFacts(nodePlatform, path, ["home-router"])["home-router"], old);
  t.deepEqual(readFailures(nodePlatform, path, ["home-ap-1"])["home-ap-1"], {
    at: now,
    error: "home-ap-1.lan (where your settings put it): not tried, no host key on record to check it against: add it in Hardware › Add",
  });
  await refreshStale({ intentPath: path, platform: offline, now: () => now + 1000 });
  t.is(attempts, 1, "not tried again so soon");
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

test("an apply's write of the schema alone keeps the pinned key, MACs and address", (t) => {
  const path = intentFile();
  const pinned = { address: "10.0.0.9", macs: ["aa:bb:cc:dd:ee:ff"], hostKey: { type: "ssh-ed25519", key: "K" } };
  writeFacts(nodePlatform, path, { hostname: "home-ap-1", readAt: 5, schema, ...pinned });
  writeFacts(nodePlatform, path, { hostname: "home-ap-1", readAt: 6, schema });
  t.like(readFacts(nodePlatform, path, ["home-ap-1"])["home-ap-1"], { readAt: 6, ...pinned });
});

test("a device that answers and then hangs is given up on in time, and rests", async (t) => {
  const path = intentFile();
  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 1, schema });
  const hanging = {
    ...nodePlatform,
    env: (name: string) => (name === "ONC_KNOWN_HOSTS" ? `${path}.known_hosts` : undefined),
    connect: () => new Promise<never>(() => {}),
    sleep: () => new Promise<void>((r) => setTimeout(r, 20)),
  };
  const now = factsMaxAgeMs + 5000;
  await refreshStale({ intentPath: path, platform: hanging, now: () => now });
  t.deepEqual(readFailures(nodePlatform, path, ["home-router"])["home-router"], { at: now, error: "did not answer in time" });
});

test("a device read in time is not marked failed when its time limit passes after", async (t) => {
  const path = intentFile();
  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 1, schema });
  const { platform } = network({ "10.0.0.1": { board: board(schema.name), macs: ["aa:bb:cc:00:00:09"], key: "ROUTER-KEY" } });
  const now = factsMaxAgeMs + 5000;
  await refreshStale({ intentPath: path, platform: { ...platform, sleep: () => new Promise<void>((r) => setTimeout(r, 30)) }, now: () => now });
  await new Promise((r) => setTimeout(r, 80));
  t.is(readFailures(nodePlatform, path, ["home-router"])["home-router"], undefined);
  t.is(readFacts(nodePlatform, path, ["home-router"])["home-router"]?.readAt, now);
});

test("a device named seen keeps its facts beside the list of devices seen", (t) => {
  const path = intentFile();
  writeFacts(nodePlatform, path, { hostname: "seen", readAt: 7, schema, hostKey: { type: "ssh-ed25519", key: "K" } });
  writeFacts(nodePlatform, path, { hostname: "seen", readAt: 8, schema });
  t.like(readFacts(nodePlatform, path, ["seen"]).seen, { readAt: 8, hostKey: { type: "ssh-ed25519", key: "K" } });
  t.deepEqual(listSeen(nodePlatform, path), ["seen"]);
});
