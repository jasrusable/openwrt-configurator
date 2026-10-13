import test from "ava";
import { sampleIntent } from "../helpers/fixtures";
import { readdirSync, readFileSync } from "fs";
import { join } from "path";
import { evaluateChecked, printWhen, when as w } from "../../plan/when";

const onRouterOnly = w.role("router");
import { section } from "../../plan/types";
import { patches } from "../../intent/patches";
import { applyPatches, Patch, patchesFor, targetCondition } from "../../intent/patches/patch";

const root = join(__dirname, "..", "..", "..");
const sample = () =>
  sampleIntent();

const knownModels = readdirSync(join(root, "deviceSchemas")).map(
  (f) => JSON.parse(readFileSync(join(root, "deviceSchemas", f), "utf8")).name as string
);

test("every patch says why, has its own id, and targets models we know or an upstream issue", (t) => {
  t.is(new Set(patches.map((p) => p.id)).size, patches.length, "ids are unique");
  for (const patch of patches) {
    t.regex(patch.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, patch.id);
    t.true(patch.why.trim().length > 20, `${patch.id} says why`);
    for (const model of patch.target.models ?? []) {
      // A mistyped board id never matches, silently; one we have a captured
      // schema for is known to be right.
      t.true(
        knownModels.includes(model) || !!patch.upstream,
        `${patch.id}: ${model} is not in deviceSchemas/ (capture it, or link the upstream issue)`
      );
    }
  }
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

const example: Patch = {
  id: "example",
  why: "An example patch for the tests, with every kind of change.",
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
