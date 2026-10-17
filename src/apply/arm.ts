// Stage and arm: put the device's agent in place, keep what a rollback would
// need from the network, then snapshot the device and start its watchdog.
// Changes no config; what a failure here leaves, the run takes back
// (provisionNetwork's armAll, with discardRollback).
import * as agent from "../agent";
import { managedFilesManifest, packagesToAdd } from "../getDeviceScript";
import { err, ok } from "../result";
import { reconnect } from "./recover";
import { DeviceRun, failure, guarded, PhaseResult } from "./run";

/**
 * Take a staged or partly armed rollback off the device: its snapshots,
 * staged packages and watchdog, over its session, else a new one (the link
 * may be what failed). Whether it is gone: one that cannot be reached keeps a
 * watchdog that fires at its deadline.
 */
export const discardRollback = async (run: DeviceRun): Promise<boolean> => {
  const dropped = await agent.call(run.ssh, agent.drop(run.runId));
  if (dropped.ok && dropped.value) return true;
  const fresh = await reconnect(run, 15).catch(() => undefined);
  if (!fresh) return false;
  const again = await agent.call(fresh, agent.drop(run.runId));
  fresh.dispose();
  return again.ok && again.value;
};

/** Put the run's agent on the device: every step of the apply there is one of its verbs. */
export const installAgent = (run: DeviceRun): Promise<PhaseResult> =>
  guarded(async () => {
    const installed = await agent.call(run.ssh, agent.install(run.runId));
    return installed.ok && installed.value
      ? ok(run)
      : err(failure(`Failed to put the apply's agent on ${run.hostname}${installed.ok ? "" : `: ${installed.error.message}`}.`));
  });

/**
 * Install the agent, and fetch the packages this run removes while the link
 * is up. Network-bound, so done for every device before any is armed: it
 * would otherwise eat the windows of those armed before it.
 */
export const stageRollback = (run: DeviceRun): Promise<PhaseResult> =>
  guarded(async () => {
    const { ssh, hostname, runId, removalCascade } = run;
    const installed = await installAgent(run);
    if (!installed.ok) return installed;
    const total = removalCascade.length;
    if (total === 0) return ok(run);
    console.log(`Staging ${total} package(s) so a rollback can reinstall them offline...`);
    const staged = await agent.call(ssh, agent.stagePackages(runId, removalCascade));
    const kept = staged.ok ? staged.value : 0;
    console.log(`Staged ${kept}/${total} package(s).`);
    // Removing what a rollback could not put back is not a change this run
    // can take back: refused, before anything is changed.
    return kept < total
      ? err(
          failure(
            `${hostname}: ${total - kept} of the ${total} package(s) this run removes could not be kept for a rollback ` +
              `(no room in /tmp, or the package feed unreachable), so they are not removed. Nothing was changed.`
          )
        )
      : ok(run);
  });

/** What a rollback of this run puts back, beyond /etc/config. */
export const armPlan = (run: DeviceRun, timeoutSeconds: number): agent.ArmPlan => {
  const { state, managedFiles } = run;
  const newFilePaths = (state.files || []).map((file) => file.path);
  return {
    timeoutSeconds,
    mode: run.rollbackMode,
    recoverSeconds: run.recoverSeconds,
    // procd's triggers cover it (netifd registers `wireless`, and `wifi
    // reload` is `ubus call network reload`): this keeps the rollback from
    // depending on that trigger still being registered.
    reloadWireless: Object.keys(state.config || {}).includes("wireless"),
    // Restoring every path the run touches puts back one that existed;
    // deleting first removes one it made. A path that does not exist is skipped.
    filesToRestore: [...new Set([...managedFiles, ...newFilePaths, managedFilesManifest])],
    filesToDelete: newFilePaths.filter((path) => !managedFiles.includes(path)),
    newPackages: packagesToAdd({ state, installedPackages: run.installedPackages }),
    services: (state.services || []).map((s) => s.name),
    // From this run's declarations, so it holds even where the files it
    // restores are older ones (an earlier fix-up hook that did not cover it).
    restartAfterRestore: state.services.filter((s) => s.restartAfterRollback).map((s) => s.name),
  };
};

const describe = (hostname: string, plan: agent.ArmPlan) =>
  `Arming rollback on ${hostname} [${plan.mode}] (restores /etc/config` +
  (plan.filesToRestore.length > 1 ? ` + ${plan.filesToRestore.length - 1} managed file(s)` : "") +
  (plan.newPackages.length > 0 ? `, removes ${plan.newPackages.length} newly installed package(s)` : "") +
  (plan.mode === "reload"
    ? " and reloads"
    : plan.mode === "reboot"
      ? " and reboots"
      : ", reloads, and reboots only if access does not return,") +
  ` if not confirmed within ${plan.timeoutSeconds}s)...`;

/** Snapshot the device and start its watchdog. */
export const armRollback = (run: DeviceRun, { timeoutSeconds }: { timeoutSeconds: number }): Promise<PhaseResult> =>
  guarded(async () => {
    const plan = armPlan(run, timeoutSeconds);
    const unarmable = agent.unarmable(plan);
    if (unarmable) return err(failure(`Cannot arm a rollback on ${run.hostname}: ${unarmable}. Nothing was changed.`));
    console.log(describe(run.hostname, plan));
    // The watchdog counts from the moment it starts sleeping, somewhere
    // inside this call: every deadline is measured from before it, so this
    // side never counts on time the device does not give (a slow answer).
    const armedAt = run.now();
    const answer = await agent.call(run.ssh, agent.arm(run.runId, plan));
    if (!(answer.ok && answer.value.armed)) {
      const why = answer.ok ? answer.value.why : answer.error.message;
      return err(failure(`Failed to arm rollback on ${run.hostname}${why ? `: ${why}` : ""}.`));
    }
    return ok({ ...run, armedAt, deadline: armedAt + timeoutSeconds * 1000 });
  });
