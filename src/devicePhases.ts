// Provisioning one device, as explicit phases over a DeviceRun record:
//
//   planDevice → armRollback → configureDevice → commitDevice → confirmDevice
//   → disarmDevice → runPostReloadHooks
//
// configureDevice is itself prepare (packages) → read the device's config →
// stage the declared config over a wipe of it → read it back and verify.
//
// plus the ways out: revertStaged (nothing committed yet), rollBackNow (a
// committed change must be undone because something else failed) and
// waitForRecovery (the watchdog rolled back; tell it not to reboot). Each
// phase takes the record and returns an updated one or throws a
// ProvisionFailure, so provisionNetwork can run them across several devices.
import { DeviceStep, Reporter } from "./applyEvents";
import {
  ConfirmTiming,
  reachableSession,
  reconnectIntervalMs,
  reconnectSettled,
  reconnectUntil,
} from "./confirm";
import {
  boardJson as boardJsonProbe,
  commitFinished,
  disarmWatchdog,
  installedPackages as installedPackagesProbe,
  managedFiles as managedFilesProbe,
  notRunning,
  pendingChanges as pendingChangesProbe,
  removalCascade as removalCascadeProbe,
  runProbe,
  runProbes,
  servicesSettled,
  uciConfigs,
} from "./deviceProbes";
import { execScript } from "./execScript";
import {
  getFinaliseCommands,
  getPackagesToRemove,
  getPostReloadCommands,
  servicesCommands,
  getPrepareCommands,
  getStageCommands,
  managedFilesManifest,
  revertPendingCommands,
} from "./getDeviceScript";
import { OpenWrtState } from "./openWrtConfigSchema";
import { Session } from "./platform";
import { declaredConfigs, isKept, unmatchedKeeps, verifyConfigs } from "./uci";
import {
  armWatchdogCommands,
  prepareRollbackCommands,
  rollBackNowCommand,
  RollbackMode,
  runPaths,
  stagePackagesForRollback,
} from "./rollback";

export type DeviceRunOptions = {
  /** Checked against board.json when the config declares one. */
  deviceModelId?: string;
  ipAddress: string;
  hostname: string;
  /** An already-connected session, reused from device introspection. */
  ssh: Session;
  /** Opens a fresh session, to reconnect after the commit. */
  connect: () => Promise<Session>;
  state: OpenWrtState;
  /** How the device recovers if the provision is never confirmed. */
  rollbackMode: RollbackMode;
  /** How long the device waits, after reverting, for us to reconnect. */
  recoverSeconds: number;
  sleep: (ms: number) => Promise<void>;
  /** The clock deadlines are measured on (Date.now; virtual in tests). */
  now: () => number;
  timing: ConfirmTiming;
  /** Where the device is, as data (applyEvents.ts); the log says it in words. */
  report?: Reporter;
};

/** Say where a device is, if anyone listens. */
const step = (run: Pick<DeviceRunOptions, "hostname" | "now" | "report">, deviceStep: DeviceStep) =>
  run.report?.({ at: run.now(), device: run.hostname, step: deviceStep });

export type DeviceRun = DeviceRunOptions & {
  runId: string;
  installedPackages: string[];
  managedFiles: string[];
  removalCascade: string[];
  prepareCommands: string[];
  /** Set by configureDevice: they depend on the config it read. */
  finaliseCommands?: string[];
  postReloadCommands: string[];
  /** Every declared service enabled and started: over the first reconnect, before confirming. */
  servicesCommands: string[];
  /** Services that must have a running process once the run is done. */
  servicesToCheck: string[];
  /** Package or file changes, which only the watchdog can undo. */
  hasIrreversibleSteps: boolean;
  /** Set by armRollback: when the watchdog started, and when it will fire. */
  armedAt?: number;
  deadline?: number;
};

/** A phase failed. `committed`: whether this device's change had been committed. */
/**
 * A failing command, as the log says it: its first line, before any heredoc
 * (a uci batch's values, a file's content: Wi-Fi keys, VPN keys) and short.
 * The log is kept and shown in the UI, so a command's body never goes there.
 */
export const commandLabel = (command: string) => {
  // Before a heredoc, a quoted value or an assignment: `uci set a.b.key='…'`
  // keeps its option's name and loses its value.
  const first = command.split("\n")[0].split(/<<|'|=/)[0].trim();
  return first.length > 120 ? `${first.slice(0, 117)}...` : first;
};

export class ProvisionFailure extends Error {
  constructor(
    message: string,
    readonly committed: boolean,
    /**
     * Nothing committed, but packages or files already changed: its watchdog
     * was left armed, as only it can undo those, so the run must roll it back
     * rather than disarm it.
     */
    readonly leftArmed = false,
    /** Reached, but its change cannot stand: roll it back now, not at its deadline. */
    readonly rollBackNow = false
  ) {
    super(message);
  }
}

/**
 * Every device confirmed and kept its change, but a step after it (a hook)
 * failed: the run is applied, not rolled back, and exits with its own code
 * so the UI does not say otherwise.
 */
export class AppliedWithProblems extends Error {}

/** A device's change was committed and then undone: the run applied nothing. */
export class RolledBack extends Error {}
export const appliedWithProblemsExit = 3;

// --- plan --------------------------------------------------------------------

/** Verify the device and work out everything the run will do. Changes nothing. */
export const planDevice = async (
  options: DeviceRunOptions
): Promise<DeviceRun> => {
  const { ssh, hostname, ipAddress, deviceModelId, state } = options;
  console.log(`Planning ${hostname} @ ${ipAddress}...`);
  step(options, "planning");

  // One round trip for everything the plan needs from the device.
  const facts = await runProbes(ssh, {
    boardJson: boardJsonProbe,
    installedPackages: installedPackagesProbe,
    pendingChanges: pendingChangesProbe,
    managedFiles: managedFilesProbe(managedFilesManifest),
  });
  const { boardJson, installedPackages, managedFiles } = facts;
  if (deviceModelId !== undefined && boardJson.model?.id !== deviceModelId) {
    throw new ProvisionFailure(
      `Mismatching device model id. Expected ${deviceModelId} but found ${boardJson.model?.id} in /etc/board.json`,
      false
    );
  }

  const packagesToRemove = getPackagesToRemove({ state, installedPackages });
  const removalCascade =
    packagesToRemove.length > 0
      ? await runProbe(ssh, removalCascadeProbe(packagesToRemove))
      : [];
  if (packagesToRemove.length > 0) {
    const extra = removalCascade.filter((p) => !packagesToRemove.includes(p));
    console.warn(
      `\n  !! ${hostname}: config removes ${packagesToRemove.join(", ")}.\n` +
        `     With --rdepends that takes ${removalCascade.length} package(s) in total:\n` +
        `       ${removalCascade.join(" ")}\n` +
        (extra.length > 0
          ? `     ${extra.length} of these are pulled in as dependents, not named in your config.\n`
          : "")
    );
  }

  // The run starts from committed state (see revertPendingCommands), so say
  // what it is about to throw away. Counts only: staged values can be secrets.
  const pending = Object.entries(facts.pendingChanges);
  if (pending.length > 0) {
    console.warn(
      `  ${hostname}: discarding uncommitted UCI changes in ` +
        pending.map(([pkg, count]) => `${pkg} (${count})`).join(", ") +
        ` (LuCI's unsaved changes are kept).`
    );
  }

  // Split off, not appended to the finalise script: `reload_config` is what
  // can sever the link, and a hook after it in the same script dies to SIGPIPE
  // the moment dropbear exits. These run over the reconnected session instead.
  const postReloadCommands = getPostReloadCommands(state);

  return {
    ...options,
    // Unique per device: several devices are armed within the same second.
    runId: `${Date.now().toString(36)}${Math.random()
      .toString(36)
      .slice(2, 6)}`,
    installedPackages,
    managedFiles,
    removalCascade,
    prepareCommands: getPrepareCommands({ state, installedPackages }),
    postReloadCommands,
    servicesCommands: servicesCommands(state),
    servicesToCheck: (state.services || []).filter((s) => s.running).map((s) => s.name),
    // `uci revert` undoes staged UCI changes and nothing else. Package
    // removals and written files are already on disk, and only the watchdog
    // can undo those.
    // Only packages not installed yet count: the rest are not touched.
    hasIrreversibleSteps:
      packagesToRemove.length > 0 ||
      (state.packagesToInstall || []).some((p) => !installedPackages.includes(p.packageName)) ||
      (state.files || []).length > 0,
  };
};

// --- arm ---------------------------------------------------------------------

/** Snapshot the device and start its rollback watchdog. Changes no config. */
export const armRollback = async (
  run: DeviceRun,
  { timeoutSeconds }: { timeoutSeconds: number }
): Promise<DeviceRun> => {
  const { ssh, hostname, state, runId, managedFiles, rollbackMode } = run;
  // Work out what a rollback would have to put back, before anything changes.
  const newFilePaths = (state.files || []).map((file) => file.path);
  // The watchdog deletes `filesToDelete` and then extracts this archive, so
  // archiving every path the run touches means one that already existed is
  // restored rather than lost. `tar` skips paths that do not exist.
  const filesToRestore = [
    ...new Set([...managedFiles, ...newFilePaths, managedFilesManifest]),
  ];
  const filesToDelete = newFilePaths.filter(
    (path) => !managedFiles.includes(path)
  );
  const packagesToUninstallOnRollback = (state.packagesToInstall || [])
    .map((p) => p.packageName)
    .filter((name) => !run.installedPackages.includes(name));

  const prepared = await execScript({
    ssh,
    commands: prepareRollbackCommands(runId),
  });
  if (!prepared.ok) {
    throw new ProvisionFailure(
      `Failed to prepare the rollback directory on ${hostname}. ` +
        `Command: ${commandLabel(prepared.command)}\n${prepared.stderr}`,
      false
    );
  }

  // Staged before arming: `apk fetch` is network-bound and can take a while,
  // and it would otherwise burn the rollback window it exists to protect.
  if (run.removalCascade.length > 0) {
    const total = run.removalCascade.length;
    console.log(
      `Staging ${total} package(s) so a rollback can reinstall them offline...`
    );
    const { staged } = await stagePackagesForRollback({
      ssh,
      rollbackDir: runPaths(runId).rollbackDir,
      packages: run.removalCascade,
    });
    console.log(`Staged ${staged}/${total} package(s).`);
    // Removing what a rollback could not put back is not a change this run
    // can take back: refused, before anything is changed.
    if (staged < total) {
      throw new ProvisionFailure(
        `${hostname}: ${total - staged} of the ${total} package(s) this run removes could not be kept for a rollback ` +
          `(no room in /tmp, or the package feed unreachable), so they are not removed. Nothing was changed.`,
        false
      );
    }
  }

  console.log(
    `Arming rollback on ${hostname} [${rollbackMode}] (restores /etc/config` +
      (filesToRestore.length > 1
        ? ` + ${filesToRestore.length - 1} managed file(s)`
        : "") +
      (packagesToUninstallOnRollback.length > 0
        ? `, removes ${packagesToUninstallOnRollback.length} newly installed package(s)`
        : "") +
      (rollbackMode === "reload"
        ? " and reloads"
        : rollbackMode === "reboot"
        ? " and reboots"
        : ", reloads, and reboots only if access does not return,") +
      ` if not confirmed within ${timeoutSeconds}s)...`
  );
  const armed = await execScript({
    ssh,
    commands: armWatchdogCommands({
      runId,
      timeoutSeconds,
      filesToRestore,
      filesToDelete,
      packagesToUninstallOnRollback,
      revertCommands: revertPendingCommands,
      mode: rollbackMode,
      recoverSeconds: run.recoverSeconds,
      // procd's triggers cover the rest, but wireless usually needs telling.
      // Belt and braces only: netifd registers `procd_add_reload_trigger
      // network wireless`, and `wifi reload` is literally `ubus call network
      // reload` — the same call netifd's own reload_service makes. So
      // reload_config already covers wireless; this just makes the rollback
      // path independent of that trigger still being registered.
      reloadWireless: Object.keys(state.config || {}).includes("wireless"),
      // From this run's declarations, so it holds even where the files it
      // restores are older ones (an earlier fix-up hook that did not cover it).
      restartAfterRestore: (state.services || []).filter((s) => s.restart_after_rollback).map((s) => s.name),
      services: (state.services || []).map((s) => s.name),
    }),
  });
  if (!armed.ok) {
    throw new ProvisionFailure(
      `Failed to arm rollback on ${hostname}. Command: ${commandLabel(armed.command)}\n${armed.stderr}`,
      false
    );
  }
  // The watchdog counts from the moment it starts sleeping, so every deadline
  // is measured from here — not from whenever the configure phase ends.
  const armedAt = run.now();
  return { ...run, armedAt, deadline: armedAt + timeoutSeconds * 1000 };
};

// --- revert (nothing committed) ----------------------------------------------

/**
 * Discard this run's staged changes after a failure before the commit.
 *
 * @param disarm cancel the pending rollback. Only safe when `uci revert`
 *   alone restores the device — otherwise the watchdog is the one thing that
 *   can put the packages and files back, and cancelling it strands them.
 */
export const revertStaged = async (
  run: DeviceRun,
  { disarm }: { disarm: boolean }
) => {
  const { ssh, hostname } = run;
  const { confirmFlag, recoveredFlag } = runPaths(run.runId);
  // Never let a problem in here replace the failure that caused the revert;
  // that original error is what the user needs to see.
  try {
    console.error(`Reverting ${hostname}...`);
    const reverted = await execScript({ ssh, commands: revertPendingCommands });
    if (!reverted.ok) {
      console.error(`Failed to revert with command: ${commandLabel(reverted.command)}`);
      console.error(reverted.stderr);
    }
    if (!run.armedAt) return;
    if (disarm) {
      await ssh.execCommand(`touch ${confirmFlag}`);
      console.error(`Reverted.`);
      step(run, "reverted");
    } else {
      // The rollback has to stay armed, because only the watchdog can put
      // the packages and files back. The *reboot* is a different question:
      // it exists to recover a device we can no longer reach, and we are
      // plainly still connected — this failure was a command exiting
      // non-zero, not a loss of access. Touching the recovered flag now
      // means the watchdog restores, reloads, finds the flag already set
      // and exits, rather than sitting out the recovery wait and rebooting
      // a device that was reachable the whole time. A genuine loss of
      // access still escalates, since it leaves us unable to touch anything.
      await ssh.execCommand(`touch ${recoveredFlag}`);
      console.error(
        `Reverted staged UCI changes on ${hostname}. Packages and files can only ` +
          `be undone by the rollback, so it is being left armed; the device will ` +
          `restore itself and reload. It will not reboot: this session is still up.`
      );
    }
  } catch (e) {
    console.error(
      `Could not revert ${hostname}: ${(e as Error)?.message ?? e}. ` +
        `If a rollback was armed the device will restore itself and reboot.`
    );
  }
};

// --- configure, commit -------------------------------------------------------

/** Run a script; on failure, report it, revert what is staged and throw. */
const runOrRevert = async (run: DeviceRun, commands: string[]) => {
  const result = await execScript({ ssh: run.ssh, commands });
  if (!result.ok) {
    console.error(
      `Command ${result.failedIndex + 1}/${commands.length} failed: ${
        commandLabel(result.command)
      }`
    );
    console.error(result.stderr);
    await failConfigure(run, `Failed to configure ${run.hostname}.`);
  }
};

const failConfigure = async (
  run: DeviceRun,
  message: string
): Promise<never> => {
  await revertStaged(run, { disarm: !run.hasIrreversibleSteps });
  throw new ProvisionFailure(message, false, run.hasIrreversibleSteps);
};

/** The device's config, staged changes included; unreadable configs refused. */
const readConfigs = async (run: DeviceRun) => {
  const keep = run.state.configsToNotReset || [];
  const { configs, unreadable } = await runProbe(run.ssh, uciConfigs);
  const blocking = unreadable.filter((configKey) => !isKept(keep, configKey));
  if (blocking.length > 0) {
    await failConfigure(
      run,
      `uci cannot read ${blocking
        .map((configKey) => `/etc/config/${configKey}`)
        .join(", ")} on ${run.hostname}, so it cannot be reset. Fix or ` +
        `delete it, or add "${blocking[0]}.*" to configs_to_not_reset.`
    );
  }
  return configs;
};

/**
 * Make the device's staged config exactly the declared one: install and
 * remove packages (which can add config), read what the device then has, wipe
 * it and set the declared config in one batch, then read it back and check.
 * Nothing is committed here, so any failure is undone by a revert.
 */
export const configureDevice = async (run: DeviceRun): Promise<DeviceRun> => {
  const { hostname, state, prepareCommands } = run;
  const keep = state.configsToNotReset || [];

  await runOrRevert(run, prepareCommands);

  const current = await readConfigs(run);
  const unmatched = unmatchedKeeps(keep, current);
  if (unmatched.length > 0) {
    console.warn(
      `  ${hostname}: configs_to_not_reset ${unmatched
        .map((entry) => `"${entry}"`)
        .join(", ")} match${unmatched.length === 1 ? "es" : ""} no config ` +
        `on the device.`
    );
  }

  const stageCommands = getStageCommands({
    state,
    current,
    managedFiles: run.managedFiles,
  });
  console.log(`Setting configuration on ${hostname}...`);
  step(run, "configuring");
  await runOrRevert(run, stageCommands);

  // The guarantee, checked rather than assumed: whatever the wipe missed or
  // something else changed meanwhile shows up here, before anything commits.
  const problems = verifyConfigs({
    actual: await readConfigs(run),
    declared: declaredConfigs(state.config),
    keep,
  });
  if (problems.length > 0) {
    console.error(problems.map((problem) => `  ${problem}`).join("\n"));
    await failConfigure(
      run,
      `The staged configuration on ${hostname} does not match the config ` +
        `file (${problems.length} difference(s)). Nothing was committed.`
    );
  }
  console.log("Configuration set and verified.");
  return {
    ...run,
    // The marker between the commits and the reload: confirming checks it,
    // as a dropped connection looks the same whether the commit finished or not.
    finaliseCommands: ((commands) => [...commands.slice(0, -1), `touch ${runPaths(run.runId).committedFlag}`, ...commands.slice(-1)])(
      getFinaliseCommands({ state, current })
    ),
  };
};

/**
 * Staging and configuring run inside the watchdog's window, so on a slow link
 * or a large config they can eat it. Committing with too little left would
 * let the watchdog fire mid-reconnect and roll back a good provision. Call
 * before committing: aborting then is still safe.
 */
/**
 * Commit only with time left to confirm every device committed so far and this
 * one, before the earliest watchdog fires: none is disarmed until all are
 * confirmed, so that one sets the deadline for them all.
 */
export const ensureTimeToConfirm = async (
  run: DeviceRun,
  earliestDeadline: number,
  confirmsLeft = 1
) => {
  const { minimumConfirmWindowMs } = run.timing;
  if (earliestDeadline - run.now() >= minimumConfirmWindowMs * confirmsLeft) return;
  await revertStaged(run, { disarm: !run.hasIrreversibleSteps });
  throw new ProvisionFailure(
    `Too little of the rollback window is left to confirm ${run.hostname} ` +
      `(less than ${
        minimumConfirmWindowMs / 1000
      }s). Nothing was committed on it. ` +
      `Re-run with a larger --confirm-timeout.`,
    false,
    run.hasIrreversibleSteps
  );
};

export const commitDevice = async (run: DeviceRun) => {
  const { ssh, hostname } = run;
  // Committing can drop the connection, since reload_config reconfigures the
  // network we are connected over. That is expected, not a failure — and it
  // does NOT surface as a thrown error: node-ssh removes its 'error' listener
  // once a command is in flight, so an abrupt close resolves with `code: null`
  // instead of rejecting. Treating that as a failed command would revert a
  // commit that actually succeeded, in exactly the case this feature exists for.
  console.log(`Committing ${hostname}...`);
  step(run, "committing");
  let commitFailed: string | undefined;
  try {
    if (!run.finaliseCommands) {
      throw new Error(`${hostname}: commitDevice before configureDevice`);
    }
    const finalised = await execScript({
      ssh,
      commands: run.finaliseCommands,
    });
    if (!finalised.ok) {
      if (finalised.disconnected) {
        console.log(
          `Connection dropped during commit (expected when network config changes).`
        );
      } else {
        commitFailed = `${commandLabel(finalised.command)}\n${finalised.stderr}`;
      }
    }
  } catch {
    console.log(
      `Connection dropped during commit (expected when network config changes).`
    );
  }
  if (commitFailed) {
    console.error(`Failed to commit: ${commitFailed}`);
    // `uci commit` may already have persisted before the failing step, and
    // `uci revert` cannot undo a commit. Only the watchdog can, so leave it
    // armed regardless of what else this run touched.
    await revertStaged(run, { disarm: false });
    throw new ProvisionFailure(
      `Failed to commit configuration on ${hostname}.`,
      true
    );
  }
  return run;
};

// --- confirm -----------------------------------------------------------------

/**
 * Reconnect after the commit, once the device's services have settled, and
 * return the session. Leaves the rollback armed: disarming is a separate step,
 * so a run over several devices can confirm them all before disarming any.
 */
export const confirmDevice = async (run: DeviceRun): Promise<Session> => {
  const { connect, ipAddress, hostname, sleep } = run;
  step(run, "confirming");
  console.log(
    run.ssh.local
      ? `Confirming that ${ipAddress} still answers SSH...`
      : `Reconnecting to ${hostname} to confirm...`
  );
  let session: Session;
  try {
    session = await reconnectSettled({
      connect,
      // Started before the settle and the confirming reconnect: what they
      // change (a stopped firewall's rules) is then inside the rollback.
      beforeSettle: async (session) => {
        if (run.servicesCommands.length === 0) return;
        // A failure here is not the verdict: the confirming reconnect is.
        const started = await execScript({ ssh: session, commands: run.servicesCommands }).catch((e: Error) => ({
          ok: false,
          stderr: e.message,
        }));
        if (!started.ok) console.warn(`${hostname}: starting its services: ${started.stderr.trim()}`);
      },
      confirmWith: reachableSession({ connect, host: ipAddress }),
      // Leave a margin so the last attempt still lands before the watchdog fires.
      deadline: (run.deadline ?? run.now()) - reconnectIntervalMs * 2,
      sleep,
      now: run.now,
    });
  } catch {
    throw new ProvisionFailure(
      `Could not reconnect to ${hostname} within its confirm window.`,
      true
    );
  }
  // Reached: but did the commit finish? The link can drop before or during
  // the uci commits as well as during the reload after them.
  const committed = await runProbe(session, commitFinished(runPaths(run.runId).committedFlag)).catch(() => false);
  if (!committed) {
    session.dispose();
    throw new ProvisionFailure(`The commit on ${hostname} did not complete before its connection dropped.`, true, false, true);
  }
  return session;
};

/** Cancel the rollback: the device is reachable and its config stays. */
/**
 * Cancel the rollback: the device is reachable and its config stays. False
 * when it came too late: the watchdog had already started restoring the old
 * config (or finished), so the device is not keeping this run's change.
 */
export const disarmDevice = async (run: DeviceRun, session: Session, { untouched = false } = {}) => {
  const result = await runProbe(session, disarmWatchdog(runPaths(run.runId)));
  if (untouched) {
    step(run, "reverted");
    return result === "disarmed";
  }
  if (result === "fired") {
    console.error(`${run.hostname} rolled itself back before it could be confirmed.`);
    step(run, "rolling-back");
    return false;
  }
  console.log(`Confirmed ${run.hostname}.`);
  step(run, "confirmed");
  return true;
};

/**
 * Run the `run_after_reload` hooks over a session known to be alive.
 *
 * A hook failing does not invalidate the provision: the config is committed
 * and live, and only the immediate application of it did not happen (a reboot
 * would apply it). So this reports loudly and fails the run rather than
 * rolling back a device that is correctly configured.
 */
export const runPostReloadHooks = async (run: DeviceRun, session: Session) => {
  const { postReloadCommands, hostname } = run;
  if (postReloadCommands.length === 0) return;
  console.log(
    `Running ${postReloadCommands.length} post-reload hook(s) on ${hostname}...`
  );
  const hooked = await execScript({
    ssh: session,
    commands: postReloadCommands,
  });
  if (!hooked.ok) {
    throw new Error(
      `${hostname} was provisioned and its configuration is live, but a ` +
        `run_after_reload hook failed: ${commandLabel(hooked.command)}\n${hooked.stderr}`
    );
  }
  console.log("Post-reload hooks completed.");
};

/**
 * After the hooks: once services settle, those that must be running are.
 * Returns what is not, in words; a warning, not a failure, since the
 * config is live and rolling a healthy network back for one daemon would
 * do more harm than the daemon.
 */
export const checkServices = async (run: DeviceRun, session: Session) => {
  const { servicesToCheck, hostname } = run;
  if (servicesToCheck.length === 0) return [];
  await runProbe(session, servicesSettled(10));
  const down = await runProbe(session, notRunning(servicesToCheck));
  return down.map(({ name, missing }) =>
    missing ? `${hostname}: ${name} is not installed` : `${hostname}: ${name} is not running`
  );
};

// --- undoing a committed change ----------------------------------------------

/**
 * After the watchdog has rolled back (on its own, or via rollBackNow), wait for
 * the device to come back. Whether it has to reboot depends on whether the
 * restore actually brought access back — which only we can tell it — so on
 * reconnecting, touch the recovered flag: a reload that worked should not cost
 * a reboot. Returns whether the device came back.
 */
export const waitForRecovery = async (run: DeviceRun) => {
  const { connect, ipAddress, hostname, sleep, rollbackMode, recoverSeconds } =
    run;
  if (rollbackMode === "reboot") return false;
  try {
    const session = await reconnectUntil({
      connect: reachableSession({ connect, host: ipAddress }),
      sleep,
      now: run.now,
      // Its own wait starts only after its restore (a package reinstall can
      // take a while) and reload: allow for those, or this gives up on a
      // device that comes back.
      deadline: run.now() + recoverSeconds * 1000 + 60_000,
    });
    await session.execCommand(`touch ${runPaths(run.runId).recoveredFlag}`);
    session.dispose();
    console.error(`${hostname} rolled back and recovered without rebooting.`);
    step(run, "rolled-back");
    return true;
  } catch {
    step(run, "recovering");
    console.error(
      `Could not reach ${hostname} after its rollback. ` +
        (rollbackMode === "reload"
          ? `--rollback=reload forbids rebooting, so the device needs manual recovery.`
          : `The device will reboot to finish recovering.`)
    );
    return false;
  }
};

/**
 * Undo a committed change now, because something else in the run failed: wake
 * the watchdog early, then wait for the device to recover. If the device
 * cannot be reached to wake it, its watchdog still fires on schedule.
 */
export const rollBackNow = async (run: DeviceRun, session?: Session) => {
  console.error(`Rolling back ${run.hostname}...`);
  step(run, "rolling-back");
  try {
    const live =
      session ??
      (await reconnectUntil({
        connect: run.connect,
        sleep: run.sleep,
        now: run.now,
        deadline: run.now() + 15000,
      }));
    await live.execCommand(rollBackNowCommand(run.runId));
    live.dispose();
  } catch {
    console.error(
      `Could not reach ${run.hostname} to start its rollback; its watchdog will at the deadline.`
    );
  }
  return waitForRecovery(run);
};
