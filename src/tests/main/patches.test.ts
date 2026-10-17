import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { evaluateChecked, printWhen, when as w } from "../../plan/when";

const onRouterOnly = w.role("router");
import { section } from "../../plan/types";
import { patches } from "../../intent/patches";
import { amendedSettings, amendOf, amendPlan, applyPatches, effectsOf, Patch, patchesFor, targetCondition } from "../../intent/patches/patch";
import { marksAt, patchMarks } from "../../intent/patches/marks";
import { compileFeatures } from "../../intent/compile";
import { explainFor } from "../../intent/fields";
import { compareReleases, oldestSupportedRelease } from "../../release";
import { compileIntent } from "../../intent/compile";
import { intentSchema } from "../../intent/schema";
import { generateIntent } from "../helpers/intentGenerator";

const root = join(__dirname, "..", "..", "..");
const sample = () =>
  sampleIntent();

const knownModels = readdirSync(join(root, "deviceSchemas")).map(
  (f) => JSON.parse(readFileSync(join(root, "deviceSchemas", f), "utf8")).name as string
);

const isUrl = (url: string) => /^https:\/\/\S+$/.test(url);

test("every patch carries its provenance: why, references with URLs, when added, where verified, when it goes", (t) => {
  t.is(new Set(patches.map((p) => p.id)).size, patches.length, "ids are unique");
  for (const patch of patches) {
    t.regex(patch.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, patch.id);
    t.true(patch.why.trim().length > 20, `${patch.id} says why`);
    t.true(patch.references.length > 0 && patch.references.every((r) => isUrl(r.url)), `${patch.id}: references with URLs`);
    if (patch.kind === "fix") {
      // A fix waits on OpenWrt: the issue or the fix to watch, so we know when it can go.
      t.true(
        patch.references.some((r) => r.kind === "issue" || r.kind === "pr" || r.kind === "docs"),
        `${patch.id}: a fix names the upstream issue, PR or code it works around`
      );
    }
    t.regex(patch.added, /^\d{4}-\d{2}-\d{2}$/, `${patch.id}: added YYYY-MM-DD`);
    t.false(Number.isNaN(Date.parse(patch.added)), `${patch.id}: added is a date`);
    t.true(patch.verified.trim().length > 5, `${patch.id}: says where it was verified`);
    t.true(patch.dropWhen.trim().length > 5, `${patch.id}: says when it goes`);
  }
});

/** A patch whose fix shipped at or before the oldest release this tool supports does nothing anywhere: drop it. */
const stale = (patch: Patch) => {
  const before = patch.target.releases?.before;
  return !!before && compareReleases(before, oldestSupportedRelease)! <= 0;
};

test("a patch fixed before the oldest supported release is one to drop", (t) => {
  for (const patch of patches) {
    t.false(stale(patch), `${patch.id}: fixed in ${patch.target.releases?.before}, at or before ${oldestSupportedRelease}: drop me`);
  }
  t.true(stale({ ...example, target: { releases: { before: "25.12.0" } } }), "the rule catches one");
  t.false(stale({ ...example, target: { releases: { before: "25.12.6" } } }));
});

test("a patch's models are ones we know (or its references show), and its targets are OpenWrt's target/subtarget", (t) => {
  for (const patch of patches) {
    for (const model of patch.target.models ?? []) {
      // A mistyped board id never matches, silently; one we have a captured
      // schema for is known to be right, else a reference must show it.
      t.true(
        knownModels.includes(model) || patch.references.some((r) => r.kind === "issue" || r.kind === "report"),
        `${patch.id}: ${model} is not in deviceSchemas/ (capture it, or reference the report)`
      );
    }
    for (const target of patch.target.targets ?? []) t.regex(target, /^[a-z0-9_-]+\/[a-z0-9_-]+$/, `${patch.id}: ${target}`);
  }
});

const generated = Array.from({ length: 80 }, (_, i) => generateIntent(1000 + i));

test("every patch's amend matches a section the compiler makes, in some generated intent", (t) => {
  for (const patch of patches.filter((p) => generated.some((intent) => p.apply(intent).amend?.length))) {
    const matched = generated.some((intent) =>
      amendedSettings([patch], intent, compileFeatures(intent)).some((a) => a.amendsAnything)
    );
    t.true(matched, `${patch.id}: amends sections, but none match in 80 generated intents`);
  }
  t.pass();
});

test("every option a patch amends traces to a setting, or the patch says what it affects", (t) => {
  for (const intent of [sample(), ...generated]) {
    for (const { patch, untraced } of amendedSettings(patches, intent, compileFeatures(intent))) {
      t.true(!untraced.length || patch.affects !== undefined, `${patch.id}: ${untraced.join(", ")} come from no setting; declare affects`);
    }
  }
});

test("every patch's title and its effects in words, derived from what it declares", (t) => {
  for (const patch of patches) {
    t.true(patch.title.trim().length > 5 && !patch.title.includes("\n"), `${patch.id}: a one-line title`);
    const intent = generated.find((i) => patch.applies?.(i) ?? true) ?? sample();
    t.true(effectsOf(patch, intent).length > 0, `${patch.id}: says what it does`);
  }
  const ft = patches.find((p) => p.id === "ft-key-race")!;
  t.deepEqual(effectsOf(ft, sample()), ["Sets ieee80211r false on wireless wifi-iface sections (of wifi.networks, where it applies)"]);
});

test("a target is an engine condition: models, roles and a range of releases", (t) => {
  const condition = targetCondition({
    models: ["friendlyarm,nanopi-r6s"],
    roles: ["router"],
    releases: { from: "25.12", before: "25.12.6" },
  });
  const on = (model: string, role: string, version: string) =>
    evaluateChecked(condition, (name) => ({
      value: { "device.model_id": model, "device.tag.role": role, "device.version": version }[name],
    }));
  t.true(on("friendlyarm,nanopi-r6s", "router", "25.12.5"));
  t.false(on("friendlyarm,nanopi-r6s", "router", "25.12.6"), "fixed upstream from 25.12.6");
  t.false(on("zyxel,nwa50ax-pro", "router", "25.12.5"));
  t.false(on("friendlyarm,nanopi-r6s", "access-point", "25.12.5"));
  t.is(printWhen(targetCondition({})), "*", "no target: every device");
  t.is(
    printWhen(condition),
    "device.model_id in ['friendlyarm,nanopi-r6s'] AND device.tag.role in ['router'] AND device.version >= '25.12' AND device.version < '25.12.6'",
    "as a hand-written config would say it"
  );
});

const provenance = {
  kind: "fix" as const,
  references: [{ kind: "issue" as const, url: "https://example.org/issue/1" }],
  added: "2026-10-13",
  verified: "in this test",
  dropWhen: "never: a test",
};

const example: Patch = {
  id: "example",
  title: "An example",
  why: "An example patch for the tests, with every kind of change.",
  ...provenance,
  target: { roles: ["access-point"], releases: { before: "26.03" } },
  applies: (intent) => intent.internet.lines[0].ipv6.enabled,
  apply: () => ({
    files: [{ path: "/etc/example", content: "x" }],
    config: { system: { example: [section({}, { enabled: true })] } },
    packages: { add: ["example-pkg"] },
    keeps: [{ config: "example", optional: true }],
    services: [{ name: "example", running: true }],
  }),
};

test("everything a patch emits carries its target; one the intent does not need emits nothing", (t) => {
  const when = targetCondition(example.target);
  t.is(printWhen(when), "device.tag.role in ['access-point'] AND device.version < '26.03'");
  const fragment = applyPatches([example])(sample());
  t.deepEqual(fragment.files, [{ path: "/etc/example", content: "x", when }]);
  t.deepEqual(fragment.config, { system: { example: [{ options: { enabled: true }, when }] } });
  t.deepEqual(fragment.packages, [{ when, add: ["example-pkg"] }]);
  t.deepEqual(fragment.keep, [{ when, entries: [{ config: "example", optional: true }] }]);
  t.deepEqual(fragment.services, [{ name: "example", running: true, when }]);
  // What a patch's section says of itself is narrowed by the target, never replaced.
  const own = applyPatches([{ ...example, apply: () => ({ config: { system: { example: [section({ when: onRouterOnly }, {})] } } }) }])(sample());
  t.is(printWhen(own.config!.system.example[0].when!), `${printWhen(when)} AND device.tag.role == 'router'`);

  const intent = sample();
  intent.internet.lines[0].ipv6.enabled = false;
  t.deepEqual(applyPatches([example])(intent), {
    devices: [],
    files: [],
    config: {},
    packages: [],
    keep: [],
    services: [],
  });
});

test("each device's patches: its role decides, what the device decides is said", (t) => {
  const r6s = patches.find((p) => p.id === "r6s-packet-steering")!;
  t.deepEqual(
    patchesFor([r6s, example], sample()).map(({ device, patches }) => [
      device,
      patches.map((p) => [p.id, p.only]),
    ]),
    [
      ["home-router", [["r6s-packet-steering", "on friendlyarm,nanopi-r6s"]]],
      [
        "home-ap-1",
        [
          ["r6s-packet-steering", "on friendlyarm,nanopi-r6s"],
          ["example", "before OpenWrt 26.03"],
        ],
      ],
    ]
  );
});

test("an amend adds an override to the sections it matches, holding only on the target, and duplicates none", (t) => {
  const amending: Patch = {
    ...example,
    id: "amending",
    target: { models: ["zyxel,nwa50ax-pro"] },
    applies: undefined,
    apply: () => ({
      amend: [{ config: "wireless", type: "wifi-iface", where: ({ section }) => section.options.mode === "ap", options: { example_option: "0" } }],
    }),
  };
  const intent = sample();
  const plain = compileIntent(intent);
  const amended = amendPlan([amending])(intent, plain);
  const before = plain.config.wireless["wifi-iface"];
  const after = amended.config.wireless["wifi-iface"];
  t.is(after.length, before.length, "no section added");
  const target = targetCondition(amending.target);
  after.forEach((section, i) => {
    const added = (section.overrides ?? []).slice((before[i].overrides ?? []).length);
    t.deepEqual(added, before[i].options.mode === "ap" ? [{ when: target, options: { example_option: "0" } }] : []);
    t.deepEqual(section.options, before[i].options, "the feature's own options untouched");
  });
});

test("restarts: after a firewall reload by an fw4 script include, after a package swap by the engine", (t) => {
  const restarting: Patch = {
    ...example,
    id: "restarting",
    applies: undefined,
    target: { roles: ["router"] },
    apply: () => ({
      restarts: [
        { service: "miniupnpd", after: "firewall-reload" },
        { service: "wpad", after: "package-change", packages: ["wpad*"] },
      ],
    }),
  };
  const fragment = applyPatches([restarting])(sample());
  const when = targetCondition(restarting.target);
  const include = fragment.config!.firewall.include[0];
  t.deepEqual(include.options, { type: "script", path: "/usr/libexec/onc/after-firewall-restarting-miniupnpd", fw4_compatible: true });
  t.deepEqual(include.when, when);
  t.true(fragment.files!.some((f) => f.path === include.options.path && /miniupnpd restart/.test(f.content)));
  t.deepEqual(fragment.services, [{ name: "wpad", restartOnPackages: ["wpad*"], when }]);
});

/** The sample with fast roaming on its first SSID only, and Nudge. */
const roaming = () => {
  const intent = sample();
  intent.wifi.networks = intent.wifi.networks.map((ssid, i) => ({ ...ssid, roaming: { ...ssid.roaming, fast: i === 0 }, ...(i === 0 ? { security: "wpa2-wpa3" as const, extra_passwords: undefined } : {}) }));
  intent.wifi.roaming.steering = "nudge";
  return intent;
};

test("a patch marks exactly the settings it overrides, by item: derived from origins, never written by hand", (t) => {
  const intent = roaming();
  const marks = patchMarks(intent).map((m) => [m.patch.id, m.path]);
  t.true(marks.some(([id, path]) => id === "ft-key-race" && path === "wifi.networks.0.roaming.fast"));
  t.false(marks.some(([id, path]) => id === "ft-key-race" && path !== "wifi.networks.0.roaming.fast"), "only the SSID with fast roaming on");
  t.true(marks.some(([id, path]) => id === "usteer-nudge-requests" && path === "wifi.roaming.steering"));
  t.deepEqual(marksAt(intent, "wifi.networks.1.roaming.fast".split(".")), [], "the other SSID: no mark");
  // The ⓘ: the patch's note, where it holds, and its reference.
  t.regex(explainFor("wifi.networks.0.roaming.fast".split("."), intent)!, /Held off with WPA3 on OpenWrt 25\.12.*from OpenWrt 25\.12\.0.*https:\/\/github\.com\/openwrt\/openwrt\/pull\/23181/);
  t.notRegex(explainFor("wifi.networks.1.roaming.fast".split("."), intent) ?? "", /Held off/);
});

test("ft-key-race: by the section's encryption, so a WPA2 SSID's 6 GHz section (SAE) is held off and its other bands are not", (t) => {
  const intent = sample();
  intent.wifi.radios["6g"].enabled = true;
  intent.wifi.networks = intent.wifi.networks.map((ssid, i) => ({ ...ssid, roaming: { ...ssid.roaming, fast: i === 0 }, security: "wpa2" as const }));
  const own = compileIntent(intent).config.wireless["wifi-iface"].filter((s) => s.origin?.item === "wifi.networks.0");
  const heldOff = (s: (typeof own)[number]) => (s.overrides ?? []).some((o) => o.options.ieee80211r === false);
  t.deepEqual(own.map((s) => [s.options.encryption, heldOff(s)]), [["psk2+ccmp", false], ["sae", true]]);
  intent.wifi.radios["6g"].enabled = false;
  t.false(patchMarks(intent).some((m) => m.patch.id === "ft-key-race"), "WPA2 without 6 GHz: not needed");
});

test("a patch turned off emits nothing and marks nothing; one that is required cannot be", (t) => {
  const intent = roaming();
  intent.system.patches = { off: ["ft-key-race"] };
  t.false(patchMarks(intent).some((m) => m.patch.id === "ft-key-race"));
  const overrides = compileIntent(intent).config.wireless["wifi-iface"].flatMap((s) => s.overrides ?? []);
  t.false(overrides.some((o) => "ieee80211r" in o.options), "no override");
  const required = patches.find((p) => p.required)!;
  const refused = intentSchema.safeParse({ ...intent, system: { ...intent.system, patches: { off: [required.id, "no-such-fix"] } } });
  t.false(refused.success);
  t.deepEqual(
    refused.success ? [] : refused.error.issues.map((i) => [i.path.join("."), i.message]),
    [
      ["system.patches.off.0", `${required.title}: this fix cannot be turned off`],
      ["system.patches.off.1", "no such fix"],
    ]
  );
});

test("a patch scoped to intent items that match nothing emits nothing and marks nothing", (t) => {
  // A WPA3 fix on an intent whose every SSID is WPA2: the device may be affected, the config is not.
  const wpa3Only: Patch = {
    ...example,
    id: "wpa3-only",
    applies: undefined,
    target: {},
    note: "A WPA3 fix",
    apply: () => ({
      amend: [amendOf("wifi.networks.*", { config: "wireless", type: "wifi-iface", where: ({ item }) => item.security !== "wpa2", options: { example: "1" } })],
    }),
  };
  const intent = sample();
  intent.wifi.networks = intent.wifi.networks.map((ssid) => ({ ...ssid, security: "wpa2" as const }));
  const plain = compileIntent(intent);
  t.deepEqual(amendPlan([wpa3Only])(intent, plain), plain, "nothing amended");
  t.deepEqual(amendedSettings([wpa3Only], intent, compileFeatures(intent)).map((a) => a.overrides), [[]], "nothing marked");
  // One SSID on WPA3: that one alone.
  intent.wifi.networks[1] = { ...intent.wifi.networks[1], security: "wpa2-wpa3" };
  t.deepEqual(amendedSettings([wpa3Only], intent, compileFeatures(intent))[0].untraced, ["example"]);
  t.true(amendPlan([wpa3Only])(intent, plain).config.wireless["wifi-iface"].some((s) => (s.overrides ?? []).some((o) => o.options.example === "1")));
});

test("the 802.11r fix holds off only WPA3 SSIDs: a WPA2 one with fast roaming keeps it on 25.12", (t) => {
  const { getOpenWrtState } = require("../../engine/getOpenWrtState") as typeof import("../../engine/getOpenWrtState");
  const { deviceSchemaSchema } = require("../../deviceSchema") as typeof import("../../deviceSchema");
  const intent = sample();
  intent.wifi.networks = [
    { ...intent.wifi.networks[0], security: "wpa2", roaming: { ...intent.wifi.networks[0].roaming, fast: true } },
    { ...intent.wifi.networks[1], security: "wpa2-wpa3", extra_passwords: undefined, roaming: { ...intent.wifi.networks[1].roaming, fast: true } },
  ];
  const plan = compileIntent(intent);
  const schema = { ...deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", "zyxel,nwa50ax-pro.json"), "utf8"))), version: "25.12.5" };
  const state = getOpenWrtState({ plan, deviceConfig: plan.devices.find((d) => d.hostname === "home-ap-1")!, deviceSchema: schema });
  const bySsid = (ssid: string) => state.config.wireless!["wifi-iface"].filter((s) => s.ssid === ssid).map((s) => s.ieee80211r);
  t.true(bySsid(intent.wifi.networks[0].ssid).every((v) => v === true), "WPA2: 802.11r kept");
  t.true(bySsid(intent.wifi.networks[1].ssid).every((v) => v === false), "WPA2/WPA3: held off");
  t.deepEqual(
    patchMarks(intent).filter((m) => m.patch.id === "ft-key-race").map((m) => m.path),
    ["wifi.networks.1.roaming.fast"],
    "only the WPA3 SSID's chip"
  );
});

test("only a patch that overrides a setting's value marks it: files, restarts and options no setting sets mark nothing", (t) => {
  const intent = roaming();
  intent.internet.upnp = true;
  const marked = new Set(patchMarks(intent).map((m) => m.patch.id));
  for (const id of ["odhcpd-ra-restart", "miniupnpd-firewall-reload", "mt76-survey-counters", "nwa50ax-eee-off", "wpad-swap-restart"]) {
    t.false(marked.has(id), `${id}: no chip`);
  }
  t.deepEqual([...marked].sort(), ["ft-key-race", "usteer-nudge-requests"]);
});

const apSchema = (version: string) => {
  const { deviceSchemaSchema } = require("../../deviceSchema") as typeof import("../../deviceSchema");
  return { ...deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", "zyxel,nwa50ax-pro.json"), "utf8"))), version };
};
const routerSchema = () => {
  const { deviceSchemaSchema } = require("../../deviceSchema") as typeof import("../../deviceSchema");
  return deviceSchemaSchema.parse(JSON.parse(readFileSync(join(root, "deviceSchemas", "friendlyarm,nanopi-r6s.json"), "utf8")));
};

test("a setting's control is greyed out only where the override holds on every device it reaches, all known", (t) => {
  const { overridesAt } = require("../../intent/patches/marks") as typeof import("../../intent/patches/marks");
  const intent = roaming();
  const steering = "wifi.roaming.steering".split(".");
  const facts = (...versions: string[]) => ({
    "home-router": { schema: routerSchema() },
    ...Object.fromEntries(versions.map((v, i) => [i ? `home-ap-${i + 1}` : "home-ap-1", { schema: apSchema(v) }])),
  });
  const [one] = overridesAt(intent, facts("25.12.5"), steering);
  t.like(one, { reached: ["home-ap-1"], overridden: ["home-ap-1"], everywhere: true }, "the only access point: greyed out");
  // A second access point past the fix (26.0): editable, the chip names the one held.
  const two = { ...intent, hardware: [...intent.hardware, { name: "home-ap-2", role: "access-point" as const, uplink: "cable" as const, wifi: true }] };
  const [partial] = overridesAt(two, facts("25.12.5", "26.0"), steering);
  t.like(partial, { reached: ["home-ap-1", "home-ap-2"], overridden: ["home-ap-1"], everywhere: false });
  const [unread] = overridesAt(intent, {}, steering);
  t.like(unread, { everywhere: false, unknown: ["home-router", "home-ap-1"] }, "facts not read: editable");
});

test("a patch never changes the stored setting; once it no longer applies, the user's value is what compiles", (t) => {
  const { getOpenWrtState } = require("../../engine/getOpenWrtState") as typeof import("../../engine/getOpenWrtState");
  const intent = roaming();
  const before = JSON.stringify(intent);
  const plan = compileIntent(intent);
  t.is(JSON.stringify(intent), before, "compiling leaves the intent as it was");
  t.is(intent.wifi.roaming.steering, "nudge");
  const ap = plan.devices.find((d) => d.hostname === "home-ap-1")!;
  const trigger = (version: string, p = plan) =>
    getOpenWrtState({ plan: p, deviceConfig: ap, deviceSchema: apSchema(version) }).config.usteer!.usteer[0].roam_trigger_snr;
  t.is(trigger("25.12.5"), "0", "held off on 25.12");
  // Past the fixed release (26.0), the same plan compiles to the user's Nudge, as without the patch at all.
  const withoutPatch = compileIntent({ ...intent, system: { ...intent.system, patches: { off: ["usteer-nudge-requests"] } } });
  t.is(trigger("26.0"), trigger("26.0", withoutPatch));
  t.not(trigger("26.0"), "0");
});
