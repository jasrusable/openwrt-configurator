import test from "ava";
import { merge3 } from "../../intent/merge";

test("edits are replayed onto a file changed elsewhere", (t) => {
  const base = { system: { name: "a" }, dns: { upstream: ["1.1.1.1"] } };
  const mine = { system: { name: "b" }, dns: { upstream: ["1.1.1.1"] } };
  const theirs = { system: { name: "a" }, dns: { upstream: ["9.9.9.9"] } };
  t.deepEqual(merge3(base, mine, theirs), { system: { name: "b" }, dns: { upstream: ["9.9.9.9"] } });
});

test("where both changed one setting, the edit being made wins", (t) => {
  t.deepEqual(merge3({ x: 1 }, { x: 2 }, { x: 3 }), { x: 2 });
});

test("a key removed by one side and untouched by the other stays removed", (t) => {
  t.deepEqual(merge3({ x: 1, y: 1 }, { y: 1 }, { x: 1, y: 2 }), { y: 2 });
  t.deepEqual(merge3({ x: 1, y: 1 }, { x: 1, y: 3 }, { y: 1 }), { y: 3 });
});

test("lists with ids merge item by item", (t) => {
  const base = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
  const mine = [{ id: "a", v: 2 }, { id: "b", v: 1 }, { id: "c", v: 1 }];
  const theirs = [{ id: "b", v: 5 }, { id: "a", v: 1 }, { id: "d", v: 1 }];
  t.deepEqual(merge3(base, mine, theirs), [
    { id: "b", v: 5 },
    { id: "a", v: 2 },
    { id: "d", v: 1 },
    { id: "c", v: 1 },
  ]);
});

test("an item removed on one side stays removed unless the other changed it", (t) => {
  const base = [{ id: "a", v: 1 }, { id: "b", v: 1 }];
  t.deepEqual(merge3(base, [{ id: "a", v: 1 }], base), [{ id: "a", v: 1 }]);
  t.deepEqual(merge3(base, [{ id: "a", v: 1 }], [{ id: "a", v: 1 }, { id: "b", v: 2 }]), [
    { id: "a", v: 1 },
    { id: "b", v: 2 },
  ]);
  t.deepEqual(merge3(base, base, [{ id: "b", v: 1 }]), [{ id: "b", v: 1 }]);
});

test("lists without ids merge by place when no item came or went, else keep the edit", (t) => {
  t.deepEqual(merge3([{ n: 1 }, { n: 1 }], [{ n: 2 }, { n: 1 }], [{ n: 1 }, { n: 3 }]), [{ n: 2 }, { n: 3 }]);
  t.deepEqual(merge3([1], [1, 2], [3]), [1, 2]);
});
