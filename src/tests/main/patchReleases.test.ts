// A patch with a range of releases applies on exactly those, through the
// engine itself: the device's release decides, on each side of each
// boundary. Every patch is probed on the releases devices run (the rig's
// matrix) and around its own boundaries, so a patch given `releases.before`
// when OpenWrt fixes its problem is checked to stop there.
import test from "ava";
import { deviceSchemaSchema } from "../../deviceSchema";
import { getOpenWrtState } from "../../engine/getOpenWrtState";
import { compileIntent } from "../../intent/compile";
import { merge } from "../../intent/fragment";
import { patches } from "../../intent/patches";
import { amendPlan, applyPatches, Patch } from "../../intent/patches/patch";
import { Intent } from "../../intent/schema";
import { compareReleases } from "../../release";
import { deviceLookup } from "../../plan/device";
import { evaluateChecked } from "../../plan/when";
import { readRepoJson, sampleIntent } from "../helpers/fixtures";

/** What devices run (scripts/rig-test.sh's matrix), plus each patch's own boundaries and a release either side. */
const released = ["25.12.0", "25.12.3", "25.12.5", "SNAPSHOT"];
const releasesFor = ({ target: { releases } }: Patch) => {
  const boundaries = [releases?.from, releases?.before].filter((r): r is string => !!r);
  const below = boundaries.map((b) => `${b}-rc1`);
  return [...new Set([...released, ...boundaries, ...below])].sort(byRelease);
};

/** Every release here is one compareReleases reads. */
const byRelease = (a: string, b: string) => compareReleases(a, b) ?? 0;

const inRange = ({ target: { releases } }: Patch, version: string) =>
  (!releases?.from || byRelease(version, releases.from) >= 0) &&
  (!releases?.before || byRelease(version, releases.before) < 0);

/** A board each role runs on, or the patch's own model. */
const boardFor = (patch: Patch, role: string) => {
  const model = patch.target.models?.[0] ?? (role === "router" ? "friendlyarm,nanopi-r6s" : "zyxel,nwa50ax-pro");
  return deviceSchemaSchema.parse(readRepoJson("deviceSchemas", `${model}.json`));
};

/** Whether a board has what the target requires beyond model, role and release (a radio). */
const requiresHold = (patch: Patch, schema: ReturnType<typeof boardFor>) =>
  !patch.target.requires || evaluateChecked(patch.target.requires.when, deviceLookup({ hostname: "probe", tags: {} }, schema));

/** A section's option holds a value: a boolean as UCI writes it, a list item by item. */
const holds = (actual: unknown, wanted: unknown) =>
  actual === wanted || String(actual) === String(typeof wanted === "boolean" ? Number(wanted) : wanted) || String(actual) === String(wanted);

/**
 * Whether everything a patch does is on a device, as the engine's state
 * shows it: its files, services, restarts and amended options. A patch of
 * `patches` comes with every compile; a test's own is merged and amended in.
 */
const evidence = (patch: Patch, intent: Intent, role: string, version: string) => {
  const builtIn = patches.includes(patch);
  const plan = builtIn ? compileIntent(intent) : amendPlan([patch])(intent, merge([compileIntent(intent), applyPatches([patch])(intent)]));
  const deviceConfig = plan.devices.find((d) => d.tags?.role === role)!;
  const state = getOpenWrtState({ plan, deviceConfig, deviceSchema: { ...boardFor(patch, role), version } });
  const own = patch.apply(intent);
  const checks = [
    ...(own.files ?? []).map((f) => state.files.some((s) => s.path === f.path)),
    ...(own.services ?? []).map((s) => state.services.some((d) => d.name === s.name)),
    ...(own.restarts ?? []).map((r) =>
      r.after === "package-change"
        ? state.services.some((s) => s.name === r.service && !!s.restartOnPackages?.length)
        : state.files.some((f) => f.path.endsWith(`after-firewall-${patch.id}-${r.service}`))
    ),
    // An amend says something only where the device has such sections (a router without radios has no SSIDs).
    ...(own.amend ?? []).filter((a) => (state.config[a.config]?.[a.type] ?? []).length).map((a) =>
      (state.config[a.config]?.[a.type] ?? []).some((section) =>
        Object.entries(a.options).every(([option, value]) => holds((section as { options?: Record<string, unknown> }).options?.[option] ?? (section as Record<string, unknown>)[option], value))
      )
    ),
  ];
  return { present: checks.every(Boolean), any: checks.length > 0 };
};

/** One test per patch, with the synthetic one below: a range on each side of its boundaries. */
const ranged: Patch = {
  id: "ranged-example",
  title: "A ranged example",
  why: "A test patch fixed upstream in 25.12.4: on before it, gone from it.",
  kind: "fix",
  references: [{ kind: "issue", url: "https://example.org/issue/ranged" }],
  added: "2026-10-13",
  verified: "in this test",
  dropWhen: "a test",
  target: { roles: ["router"], releases: { from: "25.12.1", before: "25.12.4" } },
  apply: () => ({ files: [{ path: "/etc/ranged-example", content: "x\n" }] }),
};

for (const patch of [...patches, ranged]) {
  test(`patch ${patch.id}: applies on exactly the releases it targets`, (t) => {
    const intent = sampleIntent();
    if (patch.applies && !patch.applies(intent)) return t.pass("not needed by the sample");
    const roles = patch.target.roles ?? ["router", "access-point"];
    for (const role of roles) {
      for (const version of releasesFor(patch)) {
        const seen = evidence(patch, intent, role, version);
        if (!seen.any) continue;
        // What else the target requires (a radio) is the board's to say.
        const wanted = inRange(patch, version) && requiresHold(patch, boardFor(patch, role));
        t.is(seen.present, wanted, `${role} on ${version}`);
      }
    }
  });
}

test("the probe itself: a ranged patch is present inside its range and absent outside", (t) => {
  const intent = sampleIntent();
  const on = (version: string) => evidence(ranged, intent, "router", version).present;
  t.false(on("25.12.0"));
  t.false(on("25.12.1-rc1"), "a release candidate sorts before its release");
  t.true(on("25.12.1"));
  t.true(on("25.12.3"));
  t.false(on("25.12.4"), "fixed upstream");
  t.false(on("SNAPSHOT"), "a snapshot is after every release");
});
