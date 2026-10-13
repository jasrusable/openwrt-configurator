// Intent -> the plan the engine applies (src/plan/types.ts). Pure: no device
// facts and no I/O, so the same intent always compiles to the same plan, and
// everything device-specific is a condition or placeholder the engine
// resolves later, against the live device.
import { merge } from "./fragment";
import { featureModules } from "./modules";
import { withPatchAmends } from "./patches";
import { Intent } from "./schema";
import { planIssues } from "../plan/check";
import { Plan } from "../plan/types";
import { fail, Problem } from "../problem";
import { messageOf, ok, Result } from "../result";

/** Every feature's compile steps, in their order: where two add sections of one type, earlier ones come first. */
const steps = featureModules
  .flatMap((feature) => feature.compile ?? [])
  .sort((a, b) => a.order - b.order)
  .map((step) => step.compile);

/** Every feature's sections merged, before the patches' amends: where each came from is in its origin. */
export const compileFeatures = (intent: Intent) => merge(steps.map((step) => step(intent)));

/** Every feature's sections merged, then the patches' amends over them (src/intent/patches). */
export const compileIntent = (intent: Intent): Plan => withPatchAmends(intent, compileFeatures(intent));

/**
 * An intent's plan, if it passes the plan's own check (the one every plan
 * meets, src/plan/check.ts): a compiler bug shows up when the intent is
 * saved, not halfway through an apply. Its issues in `details.issues`.
 */
export const checkCompiles = (intent: Intent): Result<Plan, Problem> => {
  let plan: Plan;
  try {
    plan = compileIntent(intent);
  } catch (e) {
    return fail("invalid", `The intent did not compile: ${messageOf(e)}`, { details: { issues: [{ path: [], message: messageOf(e) }] } });
  }
  const issues = planIssues(plan);
  return issues.length
    ? fail("invalid", `The intent compiles to a plan that is not valid: ${issues.map((i) => i.message).join("; ")}`, { details: { issues } })
    : ok(plan);
};

/** A parsed config file is an intent file if it says which intent schema it uses. */
export const isIntent = (json: unknown) =>
  !!json && typeof json === "object" && "schema" in json;
