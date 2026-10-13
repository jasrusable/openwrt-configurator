// What the web UI keeps of device reads in the browser: a read kept by an
// older build (an older format) is dropped, never shown; one older than a day
// is not put back.
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
  },
});
const now = Date.now();
// The format this build keeps, as the module says (kept in step by the last test).
const current = 3;
stored.set("onc-cache:/", JSON.stringify({ devices: { data: "format 1", updatedAt: now } }));
stored.set("onc-cache:2:/", JSON.stringify({ devices: { data: "format 2", updatedAt: now } }));
stored.set(
  `onc-cache:${current}:/`,
  JSON.stringify({
    devices: { data: "fresh", updatedAt: now - 1000 },
    "network-status": { data: "stale", updatedAt: now - 25 * 3600 * 1000 },
    "not-a-device-read": { data: "other", updatedAt: now },
  })
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { format, persistDeviceReads } = require("../../../ui/src/data/persist") as typeof import("../../../ui/src/data/persist");

test("an older format's reads are dropped as the app loads", (t) => {
  t.is(format, current, "this test's fixture is in the current format");
  t.false(stored.has("onc-cache:/"));
  t.false(stored.has("onc-cache:2:/"));
});

test("only device reads under a day old are put back", (t) => {
  const client = new QueryClient();
  persistDeviceReads(client);
  t.is(client.getQueryData(["devices"]), "fresh");
  t.is(client.getQueryData(["network-status"]), undefined);
  t.is(client.getQueryData(["not-a-device-read"]), undefined);
});
