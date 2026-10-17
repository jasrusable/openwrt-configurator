// Every client remembered: first and last seen, new today, forgotten after a
// month unless you named it, and a made-up MAC never counted as new.
import test from "ava";
import { forgetAfterMs, isNew, isPrivateMac, rememberedMax, updateRegistry, withRegistry } from "../../status/registry";
import type { ClientView } from "../../status/views";

const client = (mac: string, over: Partial<ClientView> = {}): ClientView => ({
  mac,
  ipv6: [],
  connection: { kind: "wifi", accessPoint: "loft", band: "5 GHz", signal: -60 },
  state: "online",
  reserved: false,
  heardBy: [],
  ...over,
});

const hour = 3600_000;
const day = 24 * hour;

test("a private address: the locally administered bit", (t) => {
  t.true(isPrivateMac("da:a1:19:00:00:01"));
  t.true(isPrivateMac("02:00:00:00:00:01"));
  t.false(isPrivateMac("a4:83:e7:00:00:01"), "Apple's own OUI");
  t.false(isPrivateMac("00:11:22:33:44:55"));
});

test("everyone online when remembering begins was already here; one who comes later is new for a day", (t) => {
  const start = 1_000 * day;
  const first = updateRegistry({ registry: undefined, clients: [client("a4:83:e7:00:00:01", { name: "Laptop" })], at: start });
  t.deepEqual(first.fresh, [], "already here");
  const later = updateRegistry({ registry: first.registry, clients: [client("a4:83:e7:00:00:01"), client("00:11:22:33:44:55", { name: "Printer" })], at: start + hour });
  t.deepEqual(later.fresh.map((k) => k.mac), ["00:11:22:33:44:55"]);
  const printer = later.registry.clients["00:11:22:33:44:55"];
  t.like(printer, { firstSeen: start + hour, lastSeen: start + hour, name: "Printer", connection: "wifi", accessPoint: "loft", band: "5 GHz" });
  t.true(isNew(later.registry, printer, start + 2 * hour));
  t.false(isNew(later.registry, printer, start + hour + day), "a day on, not new");
  // The laptop's name is kept when a read does not say one.
  t.is(later.registry.clients["a4:83:e7:00:00:01"].name, "Laptop");
  t.is(later.registry.clients["a4:83:e7:00:00:01"].firstSeen, start);
});

test("a private address is remembered but never new", (t) => {
  const start = 1_000 * day;
  const first = updateRegistry({ registry: undefined, clients: [], at: start });
  const next = updateRegistry({ registry: first.registry, clients: [client("da:a1:19:00:00:01")], at: start + hour });
  t.deepEqual(next.fresh, []);
  t.truthy(next.registry.clients["da:a1:19:00:00:01"]);
});

test("only clients online are seen: one holding a lease, or seen lately, keeps its last time", (t) => {
  const start = 1_000 * day;
  const first = updateRegistry({ registry: undefined, clients: [client("00:11:22:33:44:55")], at: start });
  const next = updateRegistry({ registry: first.registry, clients: [client("00:11:22:33:44:55", { state: "recent" })], at: start + hour });
  t.is(next.registry.clients["00:11:22:33:44:55"].lastSeen, start);
});

test("forgotten after a month unseen, unless you named it; at most so many remembered, the longest unseen first", (t) => {
  const start = 1_000 * day;
  const first = updateRegistry({ registry: undefined, clients: [client("00:00:00:00:00:01"), client("00:00:00:00:00:02")], at: start });
  const keep = (mac: string) => mac === "00:00:00:00:00:02";
  const later = updateRegistry({ registry: first.registry, clients: [], at: start + forgetAfterMs + 1, keep });
  t.deepEqual(Object.keys(later.registry.clients), ["00:00:00:00:00:02"]);
  const many = Array.from({ length: rememberedMax + 5 }, (_, i) => client(`00:00:00:00:${String(Math.floor(i / 256)).padStart(2, "0")}:${(i % 256).toString(16).padStart(2, "0")}`));
  const crowded = many.reduce((r, c, i) => updateRegistry({ registry: r, clients: [c], at: start + i * 1000 }).registry, first.registry);
  t.is(Object.keys(crowded.clients).length, rememberedMax);
  t.falsy(crowded.clients["00:00:00:00:00:01"], "the longest unseen went first");
});

test("the list: each client read with its times and marks, then the remembered who are away", (t) => {
  const start = 1_000 * day;
  const first = updateRegistry({ registry: undefined, clients: [client("00:00:00:00:00:01", { name: "TV", kind: "tv" })], at: start });
  const next = updateRegistry({ registry: first.registry, clients: [client("00:00:00:00:00:02"), client("da:00:00:00:00:03")], at: start + hour });
  const list = withRegistry([client("00:00:00:00:00:02"), client("da:00:00:00:00:03")], next.registry, start + hour, (mac) => mac === "00:00:00:00:00:01");
  t.deepEqual(list.map((c) => [c.mac, c.state, c.new ?? false, c.private ?? false]), [
    ["00:00:00:00:00:02", "online", true, false],
    ["da:00:00:00:00:03", "online", false, true],
    ["00:00:00:00:00:01", "away", false, false],
  ]);
  t.like(list[2], { name: "TV", kind: "tv", reserved: true, firstSeen: start, lastSeen: start, connection: { kind: "unknown" } });
  t.deepEqual(withRegistry([client("da:00:00:00:00:03")], undefined, start).map((c) => c.private), [true], "with nothing remembered, the mark still");
});
