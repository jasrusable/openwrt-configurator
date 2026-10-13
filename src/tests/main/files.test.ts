// Managed files as the engine sends them (src/getDeviceScript.ts): written in
// stage, before the commit, with their manifest; their hooks after the
// reload, a step of their own. How a file is written on the device (beside
// it, owner-only, moved over it only if it differs, run_after only then) is
// the agent's, tested under sh in agent.test.ts.
import test from "ava";
import { stateOf } from "../helpers/fixtures";
import { finaliseRecords, getDeviceScript, hookCommands, prepareRecords, stageRecords } from "../../getDeviceScript";

test("stage writes each managed file, its mode and run_after with it, then the manifest", (t) => {
  const content = '#!/bin/sh\necho "$ACTION"\n';
  const runAfter = "ACTION=add INTERFACE=phy1-ap0 sh /etc/hotplug.d/net/20-aql";
  const state = stateOf({
    config: { system: { system: [{ ".name": "system0", hostname: "r1" }] } } as any,
    files: [{ path: "/etc/hotplug.d/net/20-aql", content, mode: "0755", runAfter: runAfter }, { path: "/etc/plain", content: "x" }],
  });
  const writes = stageRecords({ state, current: {} }).filter((r) => r.kind === "write");
  t.deepEqual(writes, [
    { kind: "write", path: "/etc/hotplug.d/net/20-aql", mode: "0755", content, runAfter },
    // With no mode, 0644, as it always was.
    { kind: "write", path: "/etc/plain", mode: "0644", content: "x" },
    // So a file dropped from the config can be pruned on the next run.
    { kind: "write", path: "/etc/onc/managed_files", mode: "0644", content: "/etc/hotplug.d/net/20-aql\n/etc/plain" },
  ]);
  // Before the commit (a failed write leaves nothing committed), which is finalise's.
  t.false(finaliseRecords({ state, current: {} }).some((r) => r.kind === "write"));
});

// `run_after` fires as soon as the file is written, which is before the config
// is live — a hotplug script aimed at an interface this provision creates would
// run against an interface that does not exist yet, silently doing nothing.
// `run_after_reload` runs once the config has been committed and reloaded: a
// step of its own (hooks), over a new session, as reload_config can sever the
// link and a hook after it in the same verb would die with it.
test("run_after_reload hooks are their own step, after finalise, in file order", (t) => {
  const state = stateOf({
    config: { network: { interface: [{ ".name": "lan" }] } } as any,
    files: [
      { path: "/etc/a", content: "x", runAfter: "EARLY", runAfterReload: "HOOK-A" },
      { path: "/etc/b", content: "y" },
      { path: "/etc/c", content: "z", runAfterReload: "HOOK-C" },
    ],
  });
  t.deepEqual(hookCommands(state), ["HOOK-A", "HOOK-C"]);
  const sent = JSON.stringify([...prepareRecords({ state }), ...stageRecords({ state, current: {} }), ...finaliseRecords({ state, current: {} })]);
  t.false(sent.includes("HOOK-"), "never with prepare, stage or finalise");
  t.true(sent.includes('"runAfter":"EARLY"'));
  const script = getDeviceScript({ state });
  t.is(script[script.length - 1].split(" ")[1], "hooks", "last in the dry run");
});

test("no files: no writes and no manifest; no runAfterReload: no hooks step", (t) => {
  const state = stateOf({ config: { system: { system: [{ ".name": "s", hostname: "r1" }] } } as any });
  t.false(stageRecords({ state, current: {} }).some((r) => r.kind === "write"));
  t.false(getDeviceScript({ state }).some((verb) => verb.startsWith("onc-agent hooks")));
});
