import test from "ava";
import { merge3 } from "../../intent/merge";

test("edits are replayed onto a file changed elsewhere", (t) => {
  const base = { system: { name: "a" }, dns: { upstream: ["1.1.1.1"] } };
  const mine = { system: { name: "b" }, dns: { upstream: ["1.1.1.1"] } };
  const theirs = { system: { name: "a" }, dns: { upstream: ["9.9.9.9"] } };
  t.deepEqual(merge3(base, mine, theirs), { value: { system: { name: "b" }, dns: { upstream: ["9.9.9.9"] } }, conflicts: [] });
});

test("where both changed one setting, the edit being made wins, as a conflict", (t) => {
  t.deepEqual(merge3({ x: { y: 1 } }, { x: { y: 2 } }, { x: { y: 3 } }), { value: { x: { y: 2 } }, conflicts: ["x.y"] });
});

test("a key removed by one side and untouched by the other stays removed", (t) => {
  t.deepEqual(merge3({ x: 1, y: 1 }, { y: 1 }, { x: 1, y: 2 }).value, { y: 2 });
  t.deepEqual(merge3({ x: 1, y: 1 }, { x: 1, y: 3 }, { y: 1 }).value, { y: 3 });
});

test("lists with ids merge item by item, in their order, conflicts at the merged place", (t) => {
  const base = [{ id: "a", v: 1, w: 1 }, { id: "b", v: 1 }];
  const mine = [{ id: "a", v: 2, w: 2 }, { id: "b", v: 1 }, { id: "c", v: 1 }];
  const theirs = [{ id: "b", v: 5 }, { id: "a", v: 1, w: 3 }, { id: "d", v: 1 }];
  t.deepEqual(merge3(base, mine, theirs), {
    value: [{ id: "b", v: 5 }, { id: "a", v: 2, w: 2 }, { id: "d", v: 1 }, { id: "c", v: 1 }],
    conflicts: ["1.w"],
  });
});

test("an item removed on one side stays removed; changed on the other, the edit's list is kept", (t) => {
  const base = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
  t.deepEqual(merge3(base, [{ id: "a", v: 1 }], [...base, { id: "c", v: 1 }]).value, [{ id: "a", v: 1 }, { id: "c", v: 1 }]);
  t.deepEqual(merge3(base, [{ id: "a", v: 1 }], [{ id: "a", v: 1 }, { id: "b", v: 2 }]), { value: [{ id: "a", v: 1 }], conflicts: [""] });
  t.deepEqual(merge3(base, [{ id: "a", v: 1 }, { id: "b", v: 2 }], [{ id: "a", v: 1 }]), { value: [{ id: "a", v: 1 }, { id: "b", v: 2 }], conflicts: [""] });
});

// What the reviewer reproduced with lists merged by place: an item of theirs
// dropped, and an edit landing on another item.
test("lists without ids match items by a natural key, never by place", (t) => {
  const r = (name: string, mac: string, address: string) => ({ name, mac, address });
  const base = { reservations: [r("nas", "aa:00:00:00:00:01", "10.0.0.2"), r("tv", "aa:00:00:00:00:02", "10.0.0.3")] };
  // Mine edits the tv; theirs removed the nas and added a printer.
  const mine = { reservations: [base.reservations[0], r("tv", "aa:00:00:00:00:02", "10.0.0.9")] };
  const theirs = { reservations: [base.reservations[1], r("printer", "aa:00:00:00:00:03", "10.0.0.4")] };
  t.deepEqual(merge3(base, mine, theirs), {
    value: { reservations: [r("tv", "aa:00:00:00:00:02", "10.0.0.9"), r("printer", "aa:00:00:00:00:03", "10.0.0.4")] },
    conflicts: [],
  });
  const ssids = [{ ssid: "Home", hidden: false }, { ssid: "Guest", hidden: false }];
  t.deepEqual(
    merge3(ssids, [ssids[0], { ssid: "Guest", hidden: true }], [{ ssid: "IoT", hidden: false }, ...ssids]).value,
    [{ ssid: "IoT", hidden: false }, ssids[0], { ssid: "Guest", hidden: true }]
  );
});

test("plain values are their own key", (t) => {
  t.deepEqual(merge3(["a", "b"], ["a", "b", "c"], ["b"]), { value: ["b", "c"], conflicts: [] });
});

test("a list whose items cannot be told apart, or whose order the edit changed, is the edit's, as a conflict", (t) => {
  const rule = (name: string, ports: string) => ({ name, ports });
  const base = [rule("x", "1"), rule("x", "2")];
  t.deepEqual(merge3(base, [rule("x", "1"), rule("x", "3")], [rule("x", "4"), rule("x", "2")]), {
    value: [rule("x", "1"), rule("x", "3")],
    conflicts: [""],
  });
  t.deepEqual(merge3([1, 1], [1, 1, 2], [1]), { value: [1, 1, 2], conflicts: [""] });
  const ordered = [rule("a", "1"), rule("b", "1")];
  t.deepEqual(merge3(ordered, [ordered[1], ordered[0]], [...ordered, rule("c", "1")]), { value: [ordered[1], ordered[0]], conflicts: [""] });
});

test("a renamed item the other side changed is a conflict, not two items", (t) => {
  const base = [{ name: "ap1", role: "access-point" }];
  t.deepEqual(merge3(base, [{ name: "ap2", role: "access-point" }], [{ name: "ap1", role: "access-point", location: "Hall" }]), {
    value: [{ name: "ap2", role: "access-point" }],
    conflicts: [""],
  });
});
