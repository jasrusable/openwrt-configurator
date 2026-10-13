// What a rollback puts back, worked out before anything changes (the agent's
// own behaviour is agent.test.ts, run for real), and the removal cascade it
// stages packages for.
import test from "ava";
import { stateOf } from "../helpers/fixtures";
import * as agent from "../../agent";
import { armPlan } from "../../apply/arm";
import { DeviceRun } from "../../apply/run";
import { removalCascade } from "../../deviceProbes";
import { managedFilesManifest } from "../../getDeviceScript";

const run = (overrides: Partial<DeviceRun> = {}) =>
  ({
    runId: "r1",
    rollbackMode: "reload-then-reboot",
    recoverSeconds: 60,
    managedFiles: ["/etc/hotplug.d/net/20-aql"],
    installedPackages: ["dnsmasq"],
    state: stateOf({
      config: { wireless: {} },
      files: [
        { path: "/etc/hotplug.d/net/20-aql", content: "" },
        { path: "/etc/hotplug.d/iface/99-new", content: "" },
      ],
      packages: { add: ["dnsmasq", "nlbwmon"], remove: [] },
      services: [
        { name: "odhcpd", running: false, restartAfterRollback: true },
        { name: "firewall", running: true },
      ],
    }),
    ...overrides,
  }) as unknown as DeviceRun;

test("a rollback restores the files a run touches, removes the ones it makes, and its new packages", (t) => {
  const plan = armPlan(run(), 90);
  t.deepEqual(plan.filesToRestore, ["/etc/hotplug.d/net/20-aql", "/etc/hotplug.d/iface/99-new", managedFilesManifest]);
  t.deepEqual(plan.filesToDelete, ["/etc/hotplug.d/iface/99-new"]);
  t.deepEqual(plan.newPackages, ["nlbwmon"], "only what the device did not have");
  t.deepEqual(plan.services, ["odhcpd", "firewall"]);
  t.deepEqual(plan.restartAfterRestore, ["odhcpd"]);
  t.true(plan.reloadWireless);
  t.is(plan.timeoutSeconds, 90);
});

test("what the agent is told: scalars as quoted arguments, lists a line each on stdin, a path with spaces or a quote whole", (t) => {
  const plan = { ...armPlan(run(), 90), filesToDelete: ["/etc/other's file", " /etc/padded "] };
  const { command, stdin } = agent.arm("r1", plan);
  t.true(command.startsWith("sh /tmp/onc-agent-r1.sh arm '--timeout' '90' '--mode' 'reload-then-reboot'"));
  t.false(command.includes("other"), "no list on the command line: dropbear refuses a long one");
  t.true(stdin!.split("\n").includes("delete /etc/other's file"));
  t.true(stdin!.split("\n").includes("delete  /etc/padded "), "kept exactly, spaces and all");
});

test("a path with a line break cannot be armed: the agent reads a line each", (t) => {
  t.is(agent.unarmable(armPlan(run(), 90)), undefined);
  t.regex(agent.unarmable({ ...armPlan(run(), 90), filesToRestore: ["/etc/a\n/etc/passwd"] })!, /line break/);
});

// `--rdepends` removes dependents too, so the named packages understate it
// (firewall4 takes luci-app-firewall and the luci meta-packages on 25.12.5).
test("the removal cascade reports everything apk would purge", (t) => {
  const probe = removalCascade(["firewall4"]);
  t.is(probe.command, "apk del --simulate --rdepends 'firewall4'");
  const stdout = [
    "( 1/3) Purging luci-ssl (26.180.75667~128a781)",
    "( 2/3) Purging uhttpd (2026.06.16~7b1bec45-r1)",
    "( 3/3) Purging firewall4 (2025.03.17~b6e51575-r2)",
  ].join("\n");
  t.deepEqual(probe.parse({ stdout, stderr: "", code: 0 }), ["luci-ssl", "uhttpd", "firewall4"]);
});

test("a removal cascade apk cannot simulate is an error, never the named packages alone", (t) => {
  // The cascade is what a rollback stages: a guess would let a removal through that it cannot undo.
  t.throws(() => removalCascade(["firewall4"]).parse({ stdout: "ERROR: unknown", stderr: "", code: 1 }));
  t.throws(() => removalCascade(["firewall4"]).parse({ stdout: "OK: 10 MiB in 126 packages", stderr: "", code: 0 }));
});
