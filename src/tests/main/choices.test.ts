import test from "ava";
import { readFileSync } from "fs";
import { join } from "path";
import { availability, choiceIssues, choices } from "../../intent/choices";
import { fieldInfo } from "../../intent/fields";
import { Intent, intentSchema } from "../../intent/schema";

const sample = (): Intent =>
  intentSchema.parse(
    JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "sampleConfigs", "intent.json"), "utf8"))
  );

const issues = (intent: unknown) => {
  const parsed = intentSchema.safeParse(intent);
  return parsed.success ? [] : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
};

const setIn = (value: any, path: string[], next: unknown): any =>
  path.length === 0
    ? next
    : Array.isArray(value)
    ? value.map((v, i) => (String(i) === path[0] ? setIn(v, path.slice(1), next) : v))
    : { ...value, [path[0]]: setIn(value?.[path[0]], path.slice(1), next) };

test("every rule is about a setting that exists", (t) => {
  for (const choice of choices) {
    t.truthy(fieldInfo(choice.path.split(".")), `${choice.path} is not a labelled setting (fields.ts)`);
    t.true(!!choice.unavailable || !!choice.swap, `${choice.path} says neither why not nor what it swaps`);
  }
});

test("no dead ends: whatever the rules leave available can be chosen without breaking anything", (t) => {
  const base = sample();
  base.hardware.push({ name: "home-ap-2", role: "access-point" });
  t.deepEqual(issues(base), []);
  // Every place each rule's path matches, and every value it is about.
  const places = choices.flatMap((choice) =>
    (choice.values ?? []).flatMap((value) => {
      const parts = choice.path.split(".");
      const expand = (value: any, i: number, path: string[]): string[][] =>
        i === parts.length
          ? [path]
          : value === null || typeof value !== "object"
          ? []
          : (parts[i] === "*" ? Object.keys(value) : [parts[i]])
              .filter((k) => k in value)
              .flatMap((k) => expand(value[k], i + 1, [...path, k]));
      return expand(base, 0, []).map((path) => ({ path, value }));
    })
  );
  t.true(places.length > 10);
  for (const { path, value } of places) {
    const rules = availability(base, path.join("."));
    const option = rules.option(value);
    if (option.unavailable) continue;
    const current = path.reduce((v: any, k) => v?.[k], base);
    // Lists hold the value among others (bands); a variant's type starts the
    // variant afresh, as the UI's VariantField does; anything else is set to it.
    const next = Array.isArray(current)
      ? setIn(base, path, current.includes(value) ? current : [...current, value])
      : option.swap
      ? option.swap.apply(base)
      : path[path.length - 1] === "type"
      ? setIn(base, path.slice(0, -1), { type: value })
      : setIn(base, path, value);
    t.deepEqual(issues(next), [], `${path.join(".")} = ${JSON.stringify(value)}`);
  }
});

test("making an access point the router hands the role over", (t) => {
  const intent = sample();
  const rules = availability(intent, "hardware.1.role");
  const swap = rules.option("router").swap!;
  t.is(swap.note, "home-router becomes an access point.");
  const next = swap.apply(intent);
  t.deepEqual(
    next.hardware.map((d) => [d.name, d.role]),
    [
      ["home-router", "access-point"],
      ["home-ap-1", "router"],
    ]
  );
  t.deepEqual(issues(next), []);
  t.regex(availability(intent, "hardware.0.role").option("access-point").unavailable!, /choose Router on the device/);
});

test("why a value is not available, in words the UI and the schema share", (t) => {
  const intent = sample();
  t.is(
    availability(intent, "radios.2g.width").option("80").unavailable,
    "2.4 GHz is at most 40 MHz wide."
  );
  t.is(availability(intent, "radios.5g.width").option("80").unavailable, undefined);

  intent.wifi[0].bands = ["5g"];
  t.regex(availability(intent, "radios.5g.enabled").option(false).unavailable!, /only on 5 GHz: give it another band first/);
  t.is(availability(intent, "radios.2g.enabled").option(false).unavailable, undefined);

  intent.internet.ipv6 = false;
  t.deepEqual(availability(intent, "networks.0.ipv6").unavailable, {
    reason: "Turn on IPv6 under Internet first.",
    refuses: false,
  });

  // Steering moves devices between bands too, so one access point is enough while two bands are on.
  t.is(availability(intent, "roaming.steering").option("push").unavailable, undefined);
  const lone = sample();
  lone.radios["2g"].enabled = false;
  t.regex(availability(lone, "roaming.steering").option("nudge").unavailable!, /nowhere to steer/);
  t.regex(availability(lone, "roaming.prefer_5g").option(true).unavailable!, /Needs 2.4 GHz/);

  // The schema reports a refused value with the rule's words; an ignored one not at all.
  intent.radios["2g"].width = "80";
  intent.networks[0].ipv6 = true;
  t.deepEqual(choiceIssues(intent), [{ path: ["radios", "2g", "width"], message: "2.4 GHz is at most 40 MHz wide." }]);
});
