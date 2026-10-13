// The Apply sheet's run, as it reads it: each device among the steps, times
// in words, and the run's window read back from its events.
import test from "ava";
import { parseEvents, progressOf } from "../../applyEvents";
import { clock, duration, ended, stageStates } from "../../../ui/src/provision/run";

test("a device's steps: the ones done, the current one, the rest still to come", (t) => {
  t.deepEqual(stageStates("waiting"), ["next", "next", "next", "next"]);
  t.deepEqual(stageStates("configuring"), ["done", "current", "next", "next"]);
  t.deepEqual(stageStates("confirming"), ["done", "done", "done", "current"]);
  t.deepEqual(stageStates("confirmed"), ["done", "done", "done", "done"]);
  t.true(ended("rolled-back") && ended("reverted") && !ended("committing"));
});

test("times in words, and a countdown that never goes below zero", (t) => {
  t.is(duration(40_000), "40 s");
  t.is(duration(130_000), "2 min 10 s");
  t.is(duration(120_000), "2 min");
  t.is(clock(65_000), "1:05");
  t.is(clock(-5_000), "0:00");
});

test("the run's window and timing read back from its events", (t) => {
  const progress = progressOf(
    parseEvents(
      [
        { at: 10, device: "ap", step: "planning" },
        { at: 20, window: { confirmBy: 200, restoredBy: 260 } },
        { at: 30, device: "ap", step: "confirmed" },
        { at: 40, outcome: "applied" },
        { at: 50, window: { confirmBy: "soon" } },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n")
    )
  );
  t.deepEqual(progress.window, { confirmBy: 200, restoredBy: 260 }, "a malformed window is skipped");
  t.is(progress.startedAt, 10);
  t.is(progress.endedAt, 40);
  t.deepEqual(progress.times, { ap: { from: 10, to: 30 } });
});
