// Every command on a device ends by its time limit: a stalled client (the
// link up, no answer) once held a rig run forever.
import test from "ava";
import { limitedSession } from "../../platforms/node";

test("on Node, a command past its time limit closes the connection and answers timedOut", async (t) => {
  let disposed = false;
  const stalled = limitedSession({
    execCommand: () => new Promise(() => {}),
    dispose: () => void (disposed = true),
  } as never);
  const result = await stalled.execCommand("stage", { timeoutMs: 50 });
  t.deepEqual(result, { stdout: "", stderr: "", code: null, timedOut: true });
  t.true(disposed, "the stalled link is not used again");
});

test("on Node, a command that answers in time is untouched, and a dropped link reads as no exit status", async (t) => {
  const answering = limitedSession({
    execCommand: async () => ({ stdout: "ok", stderr: "", code: 0, signal: null }),
    dispose: () => {},
  } as never);
  t.like(await answering.execCommand("true", { timeoutMs: 1000 }), { stdout: "ok", code: 0 });
  const dropping = limitedSession({
    execCommand: async () => {
      throw new Error("Not connected");
    },
    dispose: () => {},
  } as never);
  t.like(await dropping.execCommand("true"), { code: null, stderr: "Not connected" });
});
