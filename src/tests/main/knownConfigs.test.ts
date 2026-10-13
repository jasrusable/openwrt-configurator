// Every config the compiler emits is one the plan's typo check knows, so an
// intent can never be refused by it; a hand-written file names a custom
// package's config in new_configs, which survives the low-level round trip.
import test from "ava";
import { knownConfigs } from "../../apply/knownConfigs";
import { compileIntent } from "../../intent/compile";
import { planOfLowLevel } from "../../lowLevel/parse";
import { printPlan } from "../../lowLevel/print";
import { lowLevelSchema } from "../../lowLevel/schema";
import { generateIntents } from "../helpers/intentGenerator";
import { sampleIntent } from "../helpers/fixtures";

test("every config the compiler emits is a known one", (t) => {
  const emitted = new Set(
    [sampleIntent(), ...generateIntents(200)].flatMap((intent) => Object.keys(compileIntent(intent).config))
  );
  t.deepEqual([...emitted].filter((name) => !knownConfigs.has(name)), []);
});

test("new_configs reads into the plan and prints back as written", (t) => {
  const json = {
    devices: [{ hostname: "r1", ipaddr: "10.254.0.1", tags: {}, provisioning_config: { ssh_auth: { username: "root" } } }],
    new_configs: ["myapp"],
    config: { myapp: { myapp: [{ ".name": "main", enabled: true }] } },
  };
  const plan = planOfLowLevel(lowLevelSchema.parse(json));
  t.deepEqual(plan.newConfigs, ["myapp"]);
  t.deepEqual((printPlan(plan) as { new_configs?: string[] }).new_configs, ["myapp"]);
  t.false("new_configs" in printPlan({ ...plan, newConfigs: undefined }), "absent when none: compile prints what it always has");
});
