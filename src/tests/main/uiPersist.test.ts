// What the web UI keeps of device reads in the browser: a read kept by an
// older build (an older format) is dropped, never shown; one older than a day
// is not put back; another network's (one origin serving another intent) is
// never put back.
import test from "ava";
import { QueryClient } from "@tanstack/react-query";

// The browser's storage and address, before the module reads them as it loads.
const stored = new Map<string, string>();
Object.assign(globalThis, {
  location: { pathname: "/" },
  localStorage: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    key: (i: number) => [...stored.keys()][i] ?? null,
    get length() {
      return stored.size;
    },
  },
});
const now = Date.now();
// The format this build keeps, as the module says (kept in step by the first test).
const current = 5;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { siteOf } = require("../../../ui/src/data/persist") as typeof import("../../../ui/src/data/persist");
const ours = { system: { site_id: "ours" } };
stored.set("onc-cache:/", JSON.stringify({ devices: { data: "format 1", updatedAt: now } }));
stored.set("onc-cache:4:/", JSON.stringify({ devices: { data: "format 4", updatedAt: now } }));
stored.set(
  `onc-cache:${current}:/:${siteOf(ours)}`,
  JSON.stringify({
    devices: { data: "fresh", updatedAt: now - 1000 },
    "network-status": { data: "stale", updatedAt: now - 25 * 3600 * 1000 },
    "not-a-device-read": { data: "other", updatedAt: now },
  })
);
stored.set(`onc-cache:${current}:/:${siteOf({ system: { site_id: "theirs" } })}`, JSON.stringify({ devices: { data: "theirs", updatedAt: now } }));
// Loaded again, as the app loads: it drops older formats then.
delete require.cache[require.resolve("../../../ui/src/data/persist")];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { format, persistDeviceReads } = require("../../../ui/src/data/persist") as typeof import("../../../ui/src/data/persist");

test("an older format's reads are dropped as the app loads", (t) => {
  t.is(format, current, "this test's fixture is in the current format");
  t.false(stored.has("onc-cache:/"));
  t.false(stored.has("onc-cache:4:/"));
});

test("only this network's device reads under a day old are put back, once its settings are read", (t) => {
  const client = new QueryClient();
  persistDeviceReads(client);
  t.is(client.getQueryData(["devices"]), undefined, "not before the settings say which network");
  client.setQueryData(["intent"], ours);
  t.is(client.getQueryData(["devices"]), "fresh");
  t.is(client.getQueryData(["network-status"]), undefined);
  t.is(client.getQueryData(["not-a-device-read"]), undefined);
  client.setQueryData(["intent"], { system: { site_id: "theirs" } });
  t.is(client.getQueryData(["devices"]), "theirs", "another network's reads replace these, never mix");
});
