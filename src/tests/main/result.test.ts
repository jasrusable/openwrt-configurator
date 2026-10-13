import test from "ava";
import { failure, guarded } from "../../apply/run";
import { attempt, err, map, ok, unwrapOr } from "../../result";

test("a Result says how a step went as a value", async (t) => {
  t.deepEqual(map(ok(2), (n) => n * 2), ok(4));
  t.deepEqual(map(err("no") as ReturnType<typeof err<string>>, (n: number) => n * 2), err("no"));
  t.is(unwrapOr(err("no"), () => 7), 7);
  t.deepEqual(await attempt(async () => 1, () => "thrown"), ok(1));
  t.deepEqual(await attempt(async () => { throw new Error("x"); }, (e) => (e as Error).message), err("x"));
});

// The bug this closes: a plain Error (a dropped session) once skipped the
// handling meant for a phase's own failures, and a device whose packages had
// changed was disarmed instead of rolled back.
test("anything a phase throws becomes its failure, saying what it may have left", async (t) => {
  const thrown = await guarded(async () => { throw new Error("Not connected"); }, { leftArmed: true });
  // What the device did is not known: "unreachable", not a device that said no.
  t.deepEqual(thrown, err(failure("Not connected", { leftArmed: true }, "unreachable")));
  const said = await guarded(async () => err(failure("verify failed")), { leftArmed: true });
  t.deepEqual(said, err(failure("verify failed")), "a failure the phase said itself keeps its own flags");
});
