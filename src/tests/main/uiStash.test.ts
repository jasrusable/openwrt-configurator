// Unsaved edits kept across a reload (ui/src/form/stash.ts): put back over
// the file as it is now, keeping a change made elsewhere; never another
// network's, a day-old one, or one over a file the schema no longer reads;
// gone once saved or reverted, and all forgotten when a router session ends.
import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";

Object.assign(globalThis, { location: { pathname: "/" }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 } });
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { forgetEdits, keepEdits, keptEdits } = require("../../../ui/src/form/stash") as typeof import("../../../ui/src/form/stash");
import { merge3 } from "../../intent/merge";
import { Intent } from "../../intent/schema";

const sample = JSON.parse(readFileSync(join(__dirname, "../../../sampleConfigs/intent.json"), "utf8")) as Intent;

const memoryStore = () => {
  const kept = new Map<string, string>();
  return {
    kept,
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  };
};

/** A draft as far as the stash sees it: edits, a save, a revert (draft.tsx's, which needs JSX to load). */
const draftOf = (saved: Intent) => {
  const listeners = new Set<() => void>();
  const draft = {
    saved,
    value: saved,
    subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)),
    changed: () => JSON.stringify(draft.value) !== JSON.stringify(draft.saved),
    edit: (name: string) => ((draft.value = { ...draft.value, system: { ...draft.value.system, name } }), listeners.forEach((l) => l())),
    settle: (to: Intent) => ((draft.saved = draft.value = to), listeners.forEach((l) => l())),
  };
  return draft;
};

/** What IntentForm puts back on a load: the kept edits, over the file as it is now. */
const reload = (saved: Intent, store: ReturnType<typeof memoryStore>) => {
  const kept = keptEdits(saved, store);
  return kept ? merge3(kept.base, kept.value, saved).value : saved;
};

test("an edit survives a reload, over a file changed elsewhere meanwhile", (t) => {
  const store = memoryStore();
  const draft = draftOf(sample);
  keepEdits(draft, store, 0);
  draft.edit("Edited");
  const elsewhere: Intent = { ...sample, system: { ...sample.system, timezone: "Europe/London" } };
  const again = reload(elsewhere, store);
  t.is(again.system.name, "Edited");
  t.is(again.system.timezone, "Europe/London");
});

test("nothing is kept once saved or reverted", (t) => {
  const store = memoryStore();
  const draft = draftOf(sample);
  keepEdits(draft, store, 0);
  draft.edit("Edited");
  t.is(store.kept.size, 1);
  draft.settle(sample);
  t.is(store.kept.size, 0);
  draft.edit("Edited");
  draft.settle(draft.value);
  t.is(store.kept.size, 0);
});

test("another network's edits, old ones, and ones over an unreadable file are not put back", (t) => {
  const store = memoryStore();
  const draft = draftOf(sample);
  keepEdits(draft, store, 0);
  draft.edit("Edited");
  const other: Intent = { ...sample, system: { ...sample.system, site_id: "another-site" } };
  t.is(keptEdits(other, store), undefined);

  const kept = JSON.parse([...store.kept.values()][0]);
  store.setItem([...store.kept.keys()][0], JSON.stringify({ ...kept, at: Date.now() - 2 * 24 * 3600 * 1000 }));
  t.is(keptEdits(sample, store), undefined);

  store.setItem([...store.kept.keys()][0], JSON.stringify({ ...kept, base: { schema: 99 } }));
  t.is(keptEdits(sample, store), undefined);
});

test("a router session ending forgets every kept draft, and nothing else", (t) => {
  const store = memoryStore();
  store.setItem("onc-draft:/", "{}");
  store.setItem("onc-draft:/cgi-bin/onc/", "{}");
  store.setItem("other", "kept");
  forgetEdits({ ...store, key: (i: number) => [...store.kept.keys()][i] ?? null, get length() { return store.kept.size; } });
  t.deepEqual([...store.kept.keys()], ["other"]);
});

test("edits are written once typing pauses, and never after a router session ends", async (t) => {
  const store = memoryStore();
  const draft = draftOf(sample);
  const stop = keepEdits(draft, store, 20);
  draft.edit("Edi");
  draft.edit("Edited");
  t.is(store.kept.size, 0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  t.is(keptEdits(sample, store)?.value.system.name, "Edited");

  draft.edit("Later");
  forgetEdits({ ...store, key: (i: number) => [...store.kept.keys()][i] ?? null, get length() { return store.kept.size; } });
  await new Promise((resolve) => setTimeout(resolve, 40));
  t.is(store.kept.size, 0);

  draft.edit("On leaving");
  stop();
  t.is(keptEdits(sample, store)?.value.system.name, "On leaving");
});
