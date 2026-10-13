import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { availability, choiceIssues, choices } from "../../intent/choices";
import { meshChannels } from "../../intent/radios";
import { fieldInfo } from "../../intent/fields";
import { Intent, intentSchema } from "../../intent/schema";

const sample = (): Intent =>
  sampleIntent();

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
  base.hardware.push({ name: "home-ap-2", role: "access-point", uplink: "cable" });
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
    availability(intent, "wifi.radios.2g.width").option("80").unavailable,
    "2.4 GHz is at most 40 MHz wide."
  );
  t.is(availability(intent, "wifi.radios.5g.width").option("80").unavailable, undefined);

  intent.wifi.networks[0].bands = ["5g"];
  t.regex(availability(intent, "wifi.radios.5g.enabled").option(false).unavailable!, /would be broadcast nowhere: give it another band first/);
  t.is(availability(intent, "wifi.radios.2g.enabled").option(false).unavailable, undefined);

  intent.internet.lines[0].ipv6.enabled = false;
  t.deepEqual(availability(intent, "networks.0.ipv6").unavailable, {
    reason: "Turn on IPv6 for Fibre under Internet first.",
    refuses: false,
  });

  // Steering moves devices between bands too, so one access point is enough while two bands are on.
  t.is(availability(intent, "wifi.roaming.steering").option("push").unavailable, undefined);
  const lone = sample();
  lone.wifi.radios["2g"].enabled = false;
  t.regex(availability(lone, "wifi.roaming.steering").option("nudge").unavailable!, /nowhere to steer/);
  t.regex(availability(lone, "wifi.roaming.prefer_5g").option(true).unavailable!, /Needs 2.4 GHz/);

  // The schema reports a refused value with the rule's words; an ignored one not at all.
  intent.wifi.radios["2g"].width = "80";
  intent.networks[0].ipv6 = true;
  t.deepEqual(choiceIssues(intent), [{ path: ["wifi", "radios", "2g", "width"], message: "2.4 GHz is at most 40 MHz wide." }]);
});

test("mesh dead ends: 6 GHz moves the channel, turning the mesh off or making a repeater the router leaves no problem", (t) => {
  const intent = structuredClone(sample());
  intent.wifi.mesh = { ...intent.wifi.mesh, enabled: true, key: "mesh-key-123456", band: "5g", channel: 36 };
  intent.wifi.radios["6g"].enabled = true;
  const six = availability(intent, "wifi.mesh.band").option("6g").swap!.apply(intent);
  t.is(six.wifi.mesh.channel, meshChannels["6g"][0]);
  const ap = intent.hardware.findIndex((d) => d.role === "access-point");
  intent.hardware[ap].uplink = "mesh";
  t.deepEqual(issues({ ...intent, wifi: { ...intent.wifi, mesh: { ...intent.wifi.mesh, enabled: false } } }), []);
  const swapped = availability(intent, `hardware.${ap}.role`).option("router").swap!.apply(intent);
  t.is(swapped.hardware[ap].uplink, "cable");
  t.deepEqual(issues(swapped), []);
});

test("a metered line is never the first while it carries IPv6: IPv6 goes out the first line alone", (t) => {
  const intent = intentSchema.parse(sample());
  intent.internet.lines.push({ ...intent.internet.lines[0], id: "wanb", name: "Cable", port: "eth2" });
  t.regex(String(availability(intent, "internet.lines.0.failover.metered").option(true).unavailable), /carries all your IPv6/);
  t.is(availability(intent, "internet.lines.1.failover.metered").option(true).unavailable, undefined);
  intent.internet.lines[0].ipv6.enabled = false;
  t.is(availability(intent, "internet.lines.0.failover.metered").option(true).unavailable, undefined);
});
