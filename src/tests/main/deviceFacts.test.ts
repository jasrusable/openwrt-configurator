import test from "ava";
import { sampleIntentText } from "../helpers/fixtures";
import { tempDir } from "../helpers/tempDir";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  factsMaxAgeMs,
  listSeen,
  readFacts,
  readFailures,
  renameFacts,
  retryAfterMs,
  staleDevices,
  writeFacts,
} from "../../deviceFacts";
import { deviceSchemaSchema } from "../../deviceSchema";
import { nodePlatform } from "../../platforms/node";
import { readEach, refreshStale } from "../../readEach";
import { loadConfigOrThrow } from "../../loadConfig";
import { provisionableDevices } from "../../apply/provisionConfig";
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
  t.is(JSON.parse(readFileSync(`${path}.state/devices/home-router.json`, "utf8")).value.readAt, 1234);
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
  const facts = { hostname: "home-ap-1", readAt: 5, schema, address: "10.0.0.9", hostKey: { type: "ssh-ed25519", key: "K" } };
  writeFacts(nodePlatform, path, facts);
  t.is(readFacts(nodePlatform, path, ["home-ap-1"])["home-ap-1"]?.readAt, 5);
  const file = `${path}.state/devices/home-ap-1.json`;
  const kept = { address: "10.0.0.9", hostKey: { type: "ssh-ed25519", key: "K" } };
  // An older format, the store's or from before it: read again, found meanwhile.
  for (const older of [{ format: 3, value: facts }, { ...facts, format: 3 }, facts]) {
    writeFileSync(file, JSON.stringify(older));
    t.like(readFacts(nodePlatform, path, ["home-ap-1"])["home-ap-1"], { readAt: 0, ...kept });
  }
  // The last format before the store is today's, as written then.
  writeFileSync(file, JSON.stringify({ ...facts, format: 4 }));
  t.like(readFacts(nodePlatform, path, ["home-ap-1"])["home-ap-1"], { readAt: 5, ...kept });
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

test("pins outlive facts that no longer parse: a later write keeps them, and a rename moves them", (t) => {
  const path = intentFile();
  const pinned = { address: "10.0.0.9", macs: ["aa:bb:cc:dd:ee:ff"], hostKey: { type: "ssh-ed25519", key: "K" } };
  const file = `${path}.state/devices/home-ap-1.json`;
  mkdirSync(`${path}.state/devices`, { recursive: true });
  // An older format whose schema this build no longer reads.
  writeFileSync(file, JSON.stringify({ format: 3, value: { hostname: "home-ap-1", readAt: 5, schema: { ports: "not a list" }, ...pinned } }));
  t.is(readFacts(nodePlatform, path, ["home-ap-1"])["home-ap-1"], undefined, "its facts do not read");
  renameFacts(nodePlatform, path, "home-ap-1", "ap-2");
  t.false(existsSync(file));
  writeFacts(nodePlatform, path, { hostname: "ap-2", readAt: 9, schema });
  t.like(readFacts(nodePlatform, path, ["ap-2"])["ap-2"], { readAt: 9, ...pinned });
});

test("the devices seen: every device's file, whether its facts read or not; files from before the store cleared", (t) => {
  const path = intentFile();
  const dir = `${path}.state/devices`;
  mkdirSync(dir, { recursive: true });
  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 1, schema });
  writeFileSync(`${dir}/old-ap.json`, JSON.stringify({ format: 2, value: { hostname: "old-ap", schema: "unreadable" } }));
  for (const old of ["home-router.failed.json", "inspected-10.0.0.66.json", ".seen.json"]) writeFileSync(`${dir}/${old}`, "{}");
  writeFileSync(`${dir}/seen.json`, JSON.stringify(["home-router"]));
  t.deepEqual(listSeen(nodePlatform, path).sort(), ["home-router", "old-ap"]);
  t.deepEqual(readdirSync(dir).sort(), ["home-router.json", "old-ap.json"]);
});

test("a device's MACs are in its facts after its next read: a new mesh neighbour is named from then on", async (t) => {
  const path = intentFile();
  // Facts from before it had these interfaces: no MACs, so a neighbour showing them is a bare MAC.
  writeFacts(nodePlatform, path, { hostname: "home-router", readAt: 1, schema, hostKey: { type: "ssh-ed25519", key: "ROUTER-KEY" } });
  const { platform } = network({ "10.0.0.1": { board: board(schema.name), macs: ["aa:bb:cc:00:00:09"], key: "ROUTER-KEY" } });
  const { plan } = await loadConfigOrThrow({ path, platform: nodePlatform });
  const router = provisionableDevices(plan).ready.filter((d) => d.hostname === "home-router");
  const reads = await readEach({
    intentPath: path,
    platform,
    devices: router,
    facts: readFacts(nodePlatform, path, ["home-router"]),
    timeoutMs: 5000,
    read: async () => "read",
  });
  t.true(reads[0].ok);
  // What status names neighbours by, read again after locating (src/status/read.ts).
  t.deepEqual(readFacts(nodePlatform, path, ["home-router"])["home-router"]?.macs, ["aa:bb:cc:00:00:09"]);
});
