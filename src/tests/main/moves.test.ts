// Where each client went: joined, left, roamed, changed band; a client asleep
// through one read neither left nor joined; kept per client, a week at most.
import test from "ava";
import { movesForMs, movesKept, updateMoves } from "../../status/moves";
import type { ClientView } from "../../status/views";

const phone = "a4:83:e7:00:00:01";

const on = (accessPoint: string, band = "5 GHz", mac = phone): ClientView => ({
  mac,
  ipv6: [],
  connection: { kind: "wifi", accessPoint, band, signal: -60 },
  state: "online",
  reserved: false,
  heardBy: [],
});

const s = 1000;

test("the first read places everyone and tells nothing: they were already here", (t) => {
  const first = updateMoves({ moves: undefined, clients: [on("loft")], at: 0 });
  t.deepEqual(first.byClient, {});
  t.deepEqual(first.places[phone], { accessPoint: "loft", band: "5 GHz" });
});

test("joining, roaming to another access point and moving band are each told, newest first", (t) => {
  const steps: [ClientView[], number][] = [
    [[], 0],
    [[on("loft")], 10 * s],
    [[on("lounge")], 20 * s],
    [[on("lounge", "2.4 GHz")], 30 * s],
    [[on("lounge", "2.4 GHz")], 40 * s],
  ];
  const moves = steps.reduce((m, [clients, at]) => updateMoves({ moves: m, clients, at }), undefined as ReturnType<typeof updateMoves> | undefined)!;
  t.deepEqual(
    moves.byClient[phone].map((m) => [m.kind, m.text, m.at]),
    [
      ["band", "Moved to 2.4 GHz on lounge", 30 * s],
      ["roamed", "Roamed from loft to lounge · 5 GHz", 20 * s],
      ["joined", "Joined on loft · 5 GHz", 10 * s],
    ]
  );
});

test("missed by one read is asleep, not gone; by two in a row it left, when it was first missed", (t) => {
  const placed = updateMoves({ moves: undefined, clients: [on("loft")], at: 0 });
  const asleep = updateMoves({ moves: placed, clients: [], at: 10 * s });
  const back = updateMoves({ moves: asleep, clients: [on("loft")], at: 20 * s });
  t.deepEqual(back.byClient, {}, "nothing told");
  t.deepEqual(back.places[phone], { accessPoint: "loft", band: "5 GHz" }, "its misses forgotten");
  const gone = updateMoves({ moves: updateMoves({ moves: back, clients: [], at: 30 * s }), clients: [], at: 40 * s });
  t.deepEqual(gone.byClient[phone], [{ at: 30 * s, kind: "left", text: "Left loft", accessPoint: "loft" }]);
  t.false(phone in gone.places);
  // Back after leaving: a join.
  t.is(updateMoves({ moves: gone, clients: [on("loft")], at: 50 * s }).byClient[phone][0].kind, "joined");
});

test("roaming while asleep through a read is still a roam", (t) => {
  const placed = updateMoves({ moves: undefined, clients: [on("loft")], at: 0 });
  const moved = updateMoves({ moves: updateMoves({ moves: placed, clients: [], at: 10 * s }), clients: [on("lounge")], at: 20 * s });
  t.deepEqual(moved.byClient[phone].map((m) => m.kind), ["roamed"]);
});

test("a cabled client joins and leaves by cable; each keeps its latest few for a week, and only clients remembered", (t) => {
  const desk: ClientView = { ...on("x", "5 GHz", "00:11:22:33:44:55"), connection: { kind: "wired" } };
  const joined = updateMoves({ moves: { places: {}, byClient: {} }, clients: [desk], at: 0 });
  t.is(joined.byClient[desk.mac][0].text, "Joined by cable");
  const many = Array.from({ length: movesKept + 5 }, (_, i) => i).reduce(
    (m, i) => updateMoves({ moves: m, clients: [on(i % 2 ? "loft" : "lounge")], at: (i + 1) * s }),
    updateMoves({ moves: undefined, clients: [on("lounge")], at: 0 })
  );
  t.is(many.byClient[phone].length, movesKept);
  t.deepEqual(updateMoves({ moves: many, clients: [], at: movesForMs + 100 * s }).byClient, {}, "a week on, forgotten");
  t.deepEqual(updateMoves({ moves: joined, clients: [desk], at: s, remembered: () => false }).byClient, {}, "forgotten with the registry");
});
