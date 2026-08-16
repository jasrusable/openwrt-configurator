import { OpenWrtState } from "./openWrtConfigSchema";
import { NodeSSH } from "node-ssh";
import {
  getFinaliseCommands,
  getDeviceScript,
  getPackagesToRemove,
  getRemovalCascade,
  getRevertCommands,
  heredocDelimiter,
  managedFilesManifest,
} from "./getDeviceScript";
import { execScript, stagedScriptPath } from "./execScript";
import { getBoardJson, getInstalledPackages, getManagedFiles } from "./utils";

const reconnectIntervalMs = 3000;

/** Minimum time that must remain in the rollback window before committing. */
const minimumConfirmWindowMs = 30000;

/**
 * Paths are per-run.
 *
 * With fixed paths, a second provision starting while an earlier run's watchdog
 * was still sleeping would clear the flag that had already disarmed it. The old
 * watchdog would then wake, find no flag, and restore a stale snapshot over a
 * perfectly good device. Each run now arms and disarms only its own watchdog.
 */
const runPaths = (runId: string) => ({
  rollbackDir: `/tmp/onc-rollback-${runId}`,
  confirmFlag: `/tmp/onc-confirmed-${runId}`,
  watchdogPath: `/tmp/onc-watchdog-${runId}.sh`,
  pidFile: `/tmp/onc-watchdog-${runId}.pid`,
  /** Touched once the tool gets back in *after* a rollback, so the device
   *  knows the revert restored access and it need not reboot. */
  recoveredFlag: `/tmp/onc-recovered-${runId}`,
});

/** How the device recovers if a provision is never confirmed. */
export type RollbackMode = "reload" | "reboot" | "reload-then-reboot";

/**
 * Arm a rollback that fires unless the provision is confirmed.
 *
 * Committing network or firewall changes can sever the very connection used to
 * provision, leaving no way to undo them. So before committing we snapshot
 * /etc/config and start a detached watchdog: if the tool cannot reconnect and
 * touch the confirm flag in time, the device restores the snapshot and reboots.
 *
 * `at` and `nohup` are both absent from a stock OpenWrt image; `setsid` is
 * present and a process started this way was verified to outlive the SSH
 * session that spawned it. Note that survival is not what `setsid` buys here —
 * dropbear never signals its children on disconnect, so a plain child outlives
 * the session too (measured: a remote loop writing only to a file completed
 * 12/12 iterations after its client was killed). What kills a command is
 * SIGPIPE on writing to the closed stdout pipe, which `setsid` plus redirecting
 * to /dev/null avoids entirely.
 *
 * Scope, in order of how well it rewinds:
 *  - /etc/config: snapshotted and restored wholesale.
 *  - Managed files: pre-existing ones are archived and restored; ones this run
 *    creates are deleted.
 *  - Packages installed by this run: removed again (needs no network).
 *  - Packages REMOVED by this run: reinstalled from .apk files staged before
 *    the removal, offline.
 *
 * Recovery is graduated rather than an unconditional reboot: after restoring,
 * the device reloads the affected services and then waits for us to reconnect
 * and confirm access came back. Only if that never happens does it reboot —
 * a reload that worked should not cost an outage, but a reload is not proof
 * the operator can reach the device, so the reboot has to stay as the
 * fallback. `mode` selects between reload-only, reboot-only and both.
 *
 * Killing the CLI between arming and confirming leaves the watchdog running,
 * so the device will restore and recover on its own.
 */
export const armWatchdogCommands = ({
  runId,
  timeoutSeconds,
  filesToRestore,
  filesToDelete,
  packagesToUninstallOnRollback,
  mode = "reload-then-reboot",
  recoverSeconds = 60,
  reloadWireless = false,
}: {
  runId: string;
  timeoutSeconds: number;
  filesToRestore: string[];
  filesToDelete: string[];
  packagesToUninstallOnRollback: string[];
  mode?: RollbackMode;
  /** How long to wait for the tool to reconnect after reverting. */
  recoverSeconds?: number;
  reloadWireless?: boolean;
}) => {
  const { rollbackDir, confirmFlag, watchdogPath, pidFile, recoveredFlag } =
    runPaths(runId);
  const filesArchive = `${rollbackDir}/files.tar`;
  const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;
  // Derived rather than hardcoded, for the same reason the file writer derives
  // its own: a caller-supplied path could otherwise close the heredoc early.
  const watchdogDelimiter = heredocDelimiter(
    [...filesToDelete, ...packagesToUninstallOnRollback].join("\n"),
    "ONC_WATCHDOG"
  );

  return [
    `cp -a /etc/config ${rollbackDir}/config`,
    // A file listed in the manifest may have been removed by hand, so a
    // partial archive is fine — better than aborting the whole provision.
    ...(filesToRestore.length > 0
      ? [
          `tar -cf ${filesArchive} ${filesToRestore
            .map(quote)
            .join(" ")} 2>/dev/null || true`,
        ]
      : []),
    [
      `cat > ${watchdogPath} <<'${watchdogDelimiter}'`,
      `#!/bin/sh`,
      // Recorded by the watchdog itself, so confirming can kill it during its
      // sleep rather than relying on it noticing a flag afterwards.
      `echo $$ > ${pidFile}`,
      `sleep ${timeoutSeconds}`,
      `if [ -f ${confirmFlag} ]; then rm -rf ${rollbackDir} ${confirmFlag} ${recoveredFlag} ${watchdogPath} ${pidFile}; exit 0; fi`,
      `logger -t onc "provision not confirmed within ${timeoutSeconds}s, rolling back [${mode}]"`,
      // Stage the restored copy first, then swap. Doing `mv` before `cp`
      // meant a failed copy — an overlay full from `apk add`, which is exactly
      // when rollbacks fire — rebooted the device with no /etc/config at all,
      // the one failure needing physical recovery.
      `rm -rf /etc/config.onc-new /etc/config.onc-failed`,
      `if cp -a ${rollbackDir}/config /etc/config.onc-new; then mv /etc/config /etc/config.onc-failed && mv /etc/config.onc-new /etc/config; else logger -t onc "rollback: could not stage the config snapshot, leaving current config in place"; fi`,
      // Files this run created did not exist before, so remove them.
      ...filesToDelete.map((path) => `rm -f ${quote(path)}`),
      // Files that existed before are put back as they were.
      ...(filesToRestore.length > 0
        ? [`[ -f ${filesArchive} ] && tar -xf ${filesArchive} -C /`]
        : []),
      // Undo package changes in reverse order. Removals first: a package this
      // run installed may conflict with the one it replaced (wpad-mbedtls and
      // wpad-basic-mbedtls do), so the new one has to go before the old one
      // can come back. Neither step needs the network.
      ...(packagesToUninstallOnRollback.length > 0
        ? [
            `apk del ${packagesToUninstallOnRollback.join(" ")} >/dev/null 2>&1 || logger -t onc "rollback could not remove newly installed packages"`,
          ]
        : []),
      // Reinstall from the .apk files staged before anything was removed.
      // --repositories-file /dev/null keeps this entirely offline.
      `if ls ${rollbackDir}/packages/*.apk >/dev/null 2>&1; then apk add --allow-untrusted --repositories-file /dev/null ${rollbackDir}/packages/*.apk >/dev/null 2>&1 || logger -t onc "rollback could not reinstall removed packages"; fi`,
      `sync`,
      ...(mode === "reboot"
        ? [`reboot`]
        : [
            // Reverting the config is not the same as putting the device back
            // in service: procd only re-reads what it is told to. reload_config
            // fires the triggers for every package whose config changed.
            `reload_config`,
            ...(reloadWireless ? [`wifi reload`] : []),
            // A reload is not proof the operator can reach the device again, so
            // wait for them to get back in and say so. Rebooting without this
            // check would make the reload pointless; skipping the reboot
            // without it would remove the only guaranteed recovery.
            `i=0`,
            `while [ $i -lt ${recoverSeconds} ]; do`,
            `  if [ -f ${recoveredFlag} ]; then`,
            `    logger -t onc "revert restored access, no reboot needed"`,
            `    rm -rf ${rollbackDir} ${confirmFlag} ${recoveredFlag} ${watchdogPath} ${pidFile}`,
            `    exit 0`,
            `  fi`,
            `  sleep 5`,
            `  i=$((i+5))`,
            `done`,
            ...(mode === "reload"
              ? [
                  `logger -t onc "revert did not restore access, but --rollback=reload forbids rebooting"`,
                  `exit 1`,
                ]
              : [
                  `logger -t onc "revert did not restore access within ${recoverSeconds}s, rebooting"`,
                  `sync`,
                  `reboot`,
                ]),
          ]),
      watchdogDelimiter,
    ].join("\n"),
    `chmod 0755 ${watchdogPath}`,
    `setsid ${watchdogPath} </dev/null >/dev/null 2>&1 &`,
  ];
};

/** Clear and recreate the rollback directory before anything is staged into it. */
const prepareRollbackCommands = (runId: string) => {
  const { rollbackDir, confirmFlag } = runPaths(runId);
  return [`rm -rf ${rollbackDir} ${confirmFlag}`, `mkdir -p ${rollbackDir}`];
};

/**
 * Download the .apk files for packages this run is about to remove.
 *
 * A rollback happens exactly when the network is broken, so restoring a removed
 * package has to work offline. `apk fetch` downloads them at their installed
 * version, and a rollback reinstalls with
 * `apk add --allow-untrusted --repositories-file /dev/null`, which was verified
 * to resolve with no repositories configured at all.
 *
 * Staging runs before anything is removed, while the link is still up. Note
 * that fast-moving feeds drop older builds, so a package whose exact installed
 * version is no longer published is fetched at the newest available instead.
 */
const stagePackagesForRollback = async ({
  ssh,
  rollbackDir,
  packages,
}: {
  ssh: NodeSSH;
  rollbackDir: string;
  packages: string[];
}) => {
  if (packages.length === 0) {
    return { staged: 0 };
  }

  const dir = `${rollbackDir}/packages`;
  await ssh.execCommand(`mkdir -p ${dir}`);
  await ssh.execCommand(
    `apk fetch --output ${dir} ${packages.map((p) => `'${p}'`).join(" ")}`
  );

  const counted = await ssh.execCommand(`ls ${dir}/*.apk 2>/dev/null | wc -l`);
  return { staged: Number(counted.stdout.trim()) || 0 };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reconnect, retrying until the deadline.
 *
 * `reload_config` can take the network down briefly, so a single attempt right
 * after committing is likely to fail even on a perfectly healthy device — and
 * treating that as a failure would reboot it for no reason. Keep trying until
 * shortly before the watchdog is due to fire.
 */
const reconnectUntil = async ({
  connect,
  deadline,
}: {
  connect: () => Promise<NodeSSH>;
  deadline: number;
}) => {
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await connect();
    } catch (e) {
      lastError = e;
      if (Date.now() + reconnectIntervalMs >= deadline) break;
      await sleep(reconnectIntervalMs);
    }
  }
  throw lastError ?? new Error("Timed out reconnecting");
};

export const provisionOpenWrtDevice = async ({
  deviceModelId,
  ipAddress,
  hostname,
  ssh,
  connect,
  state,
  confirm = true,
  confirmTimeoutSeconds = 90,
  rollbackMode = "reload-then-reboot",
  recoverSeconds = 60,
}: {
  deviceModelId: string;
  ipAddress: string;
  hostname: string;
  /** An already-connected session, reused from device introspection. */
  ssh: NodeSSH;
  /** Re-establishes a session after the commit, to confirm the device is alive. */
  connect: () => Promise<NodeSSH>;
  state: OpenWrtState;
  confirm?: boolean;
  confirmTimeoutSeconds?: number;
  /** How the device recovers if the provision is never confirmed. */
  rollbackMode?: RollbackMode;
  /** How long the device waits, after reverting, for us to reconnect. */
  recoverSeconds?: number;
}) => {
  console.log(`Provisioning ${hostname} @ ${ipAddress}...`);

  const runId = `${Date.now().toString(36)}`;
  const { confirmFlag } = runPaths(runId);

  console.log(`Verifying device...`);
  const boardJson = await getBoardJson(ssh);
  if (boardJson.model.id !== deviceModelId) {
    throw new Error(
      `Mismatching device model id. Expected ${deviceModelId} but found ${boardJson.model.id} in /etc/board.json`
    );
  }
  console.log("Verified.");

  const installedPackages = await getInstalledPackages(ssh);

  const packagesToRemove = getPackagesToRemove({ state, installedPackages });
  const removalCascade =
    packagesToRemove.length > 0
      ? await getRemovalCascade({ ssh, packages: packagesToRemove })
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

  const allCommands = await getDeviceScript({ state, ssh, installedPackages });
  // Derived from the same state, so the split stays correct however many
  // commands the finalise segment turns out to be: the commit now names each
  // touched config, and `run_after_reload` hooks are appended after the reload.
  const finaliseCommands = getFinaliseCommands(state);
  const configureCommands = allCommands.slice(
    0,
    allCommands.length - finaliseCommands.length
  );

  // The watchdog counts from the moment it starts sleeping, so every deadline
  // below is measured from here — not from whenever the configure phase ends.
  let armedAt: number | undefined;

  // `uci revert` undoes staged UCI changes and nothing else. Package removals
  // and written files are already on disk, and only the watchdog can undo those.
  const hasIrreversibleSteps =
    packagesToRemove.length > 0 ||
    (state.packagesToInstall || []).length > 0 ||
    (state.files || []).length > 0;

  const revertCommands = getRevertCommands(state);

  /**
   * @param disarm cancel the pending rollback. Only safe when `uci revert`
   *   alone restores the device — otherwise the watchdog is the one thing that
   *   can put the packages and files back, and cancelling it strands them.
   */
  const revert = async (session: NodeSSH, { disarm }: { disarm: boolean }) => {
    // Never let a problem in here replace the failure that caused the revert;
    // that original error is what the user needs to see.
    try {
      console.error(`Reverting...`);
      const reverted = await execScript({
        ssh: session,
        commands: revertCommands,
      });
      if (!reverted.ok) {
        console.error(`Failed to revert with command: ${reverted.command}`);
        console.error(reverted.stderr);
      }
      if (disarm) {
        await session.execCommand(`touch ${confirmFlag}`);
        console.error(`Reverted.`);
      } else {
        console.error(
          `Reverted staged UCI changes. Packages and files cannot be undone ` +
            `from here, so the rollback is being left armed — the device will ` +
            `restore itself and reboot within ${confirmTimeoutSeconds}s.`
        );
      }
    } catch (e) {
      console.error(
        `Could not revert ${hostname}: ${(e as Error)?.message ?? e}. ` +
          `If a rollback was armed the device will restore itself and reboot.`
      );
    }
  };

  if (confirm) {
    // Work out what a rollback would have to put back, before anything changes.
    const previouslyManagedFiles = await getManagedFiles(
      ssh,
      managedFilesManifest
    );
    const newFilePaths = (state.files || []).map((file) => file.path);
    // The watchdog deletes `filesToDelete` and then extracts this archive, so
    // archiving every path the run touches means one that already existed is
    // restored rather than lost. `tar` skips paths that do not exist.
    const filesToRestore = [
      ...new Set([
        ...previouslyManagedFiles,
        ...newFilePaths,
        managedFilesManifest,
      ]),
    ];
    const filesToDelete = newFilePaths.filter(
      (path) => !previouslyManagedFiles.includes(path)
    );
    const packagesToUninstallOnRollback = (state.packagesToInstall || [])
      .map((p) => p.packageName)
      .filter((name) => !installedPackages.includes(name));

    const prepared = await execScript({
      ssh,
      commands: prepareRollbackCommands(runId),
    });
    if (!prepared.ok) {
      throw new Error(
        `Failed to prepare the rollback directory on ${hostname}. ` +
          `Command: ${prepared.command}\n${prepared.stderr}`
      );
    }

    // Staged before arming: `apk fetch` is network-bound and can take a while,
    // and it would otherwise burn the rollback window it exists to protect.
    if (removalCascade.length > 0) {
      console.log(
        `Staging ${removalCascade.length} package(s) so a rollback can reinstall them offline...`
      );
      const { staged } = await stagePackagesForRollback({
        ssh,
        rollbackDir: runPaths(runId).rollbackDir,
        packages: removalCascade,
      });
      console.log(`Staged ${staged}/${removalCascade.length} package(s).`);
      if (staged < removalCascade.length) {
        console.warn(
          `  !! ${removalCascade.length - staged} package(s) could not be staged; ` +
            `a rollback will not be able to reinstall those.`
        );
      }
    }

    console.log(
      `Arming rollback [${rollbackMode}] (restores /etc/config` +
        `${filesToRestore.length > 1 ? ` + ${filesToRestore.length - 1} managed file(s)` : ""}` +
        `${packagesToUninstallOnRollback.length > 0 ? `, removes ${packagesToUninstallOnRollback.length} newly installed package(s)` : ""}` +
        ` and reboots if not confirmed within ${confirmTimeoutSeconds}s)...`
    );
    const armed = await execScript({
      ssh,
      commands: armWatchdogCommands({
        runId,
        timeoutSeconds: confirmTimeoutSeconds,
        filesToRestore,
        filesToDelete,
        packagesToUninstallOnRollback,
        mode: rollbackMode,
        recoverSeconds,
        // procd's triggers cover the rest, but wireless usually needs telling.
        // Belt and braces only: netifd registers `procd_add_reload_trigger
        // network wireless`, and `wifi reload` is literally `ubus call network
        // reload` — the same call netifd's own reload_service makes. So
        // reload_config already covers wireless; this just makes the rollback
        // path independent of that trigger still being registered.
        reloadWireless: Object.keys(state.config || {}).includes("wireless"),
      }),
    });
    if (!armed.ok) {
      throw new Error(
        `Failed to arm rollback on ${hostname}. Command: ${armed.command}\n${armed.stderr}`
      );
    }
    armedAt = Date.now();
  }

  console.log(`Setting configuration (${configureCommands.length} commands)...`);
  const configured = await execScript({ ssh, commands: configureCommands });
  if (!configured.ok) {
    console.error(
      `Command ${configured.failedIndex + 1}/${configureCommands.length} failed: ${configured.command}`
    );
    console.error(configured.stderr);
    await revert(ssh, { disarm: !hasIrreversibleSteps });
    throw new Error(
      `Failed to provision ${hostname}. Aborting and rolling back.`
    );
  }
  console.log("Configuration set.");

  const confirmDeadline =
    (armedAt ?? Date.now()) + confirmTimeoutSeconds * 1000;

  // Staging and configuring run inside the same window, so on a slow link or a
  // large config they can eat it. Committing with too little left would let the
  // watchdog fire mid-reconnect and roll back a perfectly good provision.
  // Nothing is committed yet, so aborting here is safe.
  if (confirm && confirmDeadline - Date.now() < minimumConfirmWindowMs) {
    await revert(ssh, { disarm: !hasIrreversibleSteps });
    throw new Error(
      `Configuring ${hostname} took longer than the ${confirmTimeoutSeconds}s rollback window, ` +
        `leaving too little time to confirm. Nothing was committed. ` +
        `Re-run with a larger --confirm-timeout.`
    );
  }

  // Committing can drop the connection, since reload_config reconfigures the
  // network we are connected over. That is expected, not a failure — and it
  // does NOT surface as a thrown error: node-ssh removes its 'error' listener
  // once a command is in flight, so an abrupt close resolves with `code: null`
  // instead of rejecting. Treating that as a failed command would revert a
  // commit that actually succeeded, in exactly the case this feature exists for.
  console.log("Committing...");
  let commitFailed: string | undefined;
  try {
    const finalised = await execScript({ ssh, commands: finaliseCommands });
    if (!finalised.ok) {
      if (finalised.disconnected) {
        console.log(
          `Connection dropped during commit (expected when network config changes).`
        );
      } else {
        commitFailed = `${finalised.command}\n${finalised.stderr}`;
      }
    }
  } catch (e) {
    console.log(
      `Connection dropped during commit (expected when network config changes).`
    );
  }

  if (commitFailed) {
    console.error(`Failed to commit: ${commitFailed}`);
    // `uci commit` may already have persisted before the failing step, and
    // `uci revert` cannot undo a commit. Only the watchdog can, so leave it
    // armed regardless of what else this run touched.
    await revert(ssh, { disarm: false });
    throw new Error(`Failed to commit configuration on ${hostname}.`);
  }

  if (!confirm) {
    console.log("Provisioning completed (unconfirmed).");
    return;
  }

  console.log("Reconnecting to confirm...");
  ssh.dispose();

  // Leave a margin so the last attempt still has time to land before the
  // watchdog fires.
  const deadline = confirmDeadline - reconnectIntervalMs * 2;
  let confirmSession: NodeSSH;
  try {
    confirmSession = await reconnectUntil({ connect, deadline });
  } catch (e) {
    // The window has closed, so the watchdog is now reverting. Whether the
    // device has to reboot depends on whether the revert actually restored
    // access — which only we can tell it. Keep trying, and if we get back in,
    // say so; a reload that worked should not cost a reboot.
    if (rollbackMode === "reboot") {
      throw new Error(
        `Could not reconnect to ${hostname} after commit. The device will restore ` +
          `its previous configuration and reboot shortly.`
      );
    }

    console.error(
      `Could not reconnect to ${hostname} within the confirm window; the device ` +
        `is rolling back. Waiting up to ${recoverSeconds}s to see if the revert restores access...`
    );

    let recoveredSession: NodeSSH | undefined;
    try {
      recoveredSession = await reconnectUntil({
        connect,
        deadline: Date.now() + recoverSeconds * 1000,
      });
    } catch {
      throw new Error(
        `Could not reach ${hostname} after its rollback either. ` +
          (rollbackMode === "reload"
            ? `--rollback=reload forbids rebooting, so the device needs manual recovery.`
            : `The device will reboot to finish recovering.`)
      );
    }

    await recoveredSession.execCommand(`touch ${runPaths(runId).recoveredFlag}`);
    recoveredSession.dispose();
    throw new Error(
      `Provisioning ${hostname} was rolled back: the new configuration cut off access. ` +
        `The previous configuration was restored and the device recovered without rebooting.`
    );
  }

  // Touch the flag first so the watchdog disarms even if the kill fails, then
  // kill it outright: the flag is only read after its sleep ends, which leaves
  // a window where it could fire between the check and the touch. Killing it
  // mid-sleep is decisive rather than advisory.
  //
  // The staged script is normally removed by the run that executes it, but a
  // run cut short by the commit severing the connection leaves it behind, and
  // it embeds config values.
  const { pidFile, rollbackDir, watchdogPath } = runPaths(runId);
  const disarmed = await confirmSession.execCommand(
    [
      `touch ${confirmFlag}`,
      `kill "$(cat ${pidFile} 2>/dev/null)" 2>/dev/null`,
      `rm -f ${stagedScriptPath}`,
      `if [ -f ${pidFile} ] && kill -0 "$(cat ${pidFile})" 2>/dev/null; then echo ONC_ARMED; else echo ONC_DISARMED; fi`,
    ].join("; ")
  );

  if (disarmed.stdout.includes("ONC_DISARMED")) {
    // Killing the watchdog means it never reaches its own cleanup branch, so
    // everything it would have removed has to be removed here instead.
    await confirmSession.execCommand(
      `rm -rf ${rollbackDir} ${pidFile} ${confirmFlag} ${watchdogPath}`
    );
    console.log("Confirmed. Provisioning completed.");
  } else {
    console.warn(
      `Confirmed, but could not verify the rollback watchdog stopped on ${hostname}. ` +
        `The confirm flag is set, so it should exit on its own within ${confirmTimeoutSeconds}s — ` +
        `check that the device does not reboot.`
    );
  }
  confirmSession.dispose();
};
