// The commit-confirm rollback that runs on the device: per-run paths, the
// detached watchdog script, and staging removed packages so a rollback can
// reinstall them with the network down. Pure command generation apart from
// stagePackagesForRollback, which runs over a session.
import { heredocDelimiter } from "./getDeviceScript";
import { Session } from "./platform";
import { shellQuote } from "./shell";
import { runProbe, stagedPackageCount } from "./deviceProbes";

/**
 * Paths are per-run.
 *
 * With fixed paths, a second provision starting while an earlier run's watchdog
 * was still sleeping would clear the flag that had already disarmed it. The old
 * watchdog would then wake, find no flag, and restore a stale snapshot over a
 * perfectly good device. Each run now arms and disarms only its own watchdog.
 */
export const runPaths = (runId: string) => ({
  rollbackDir: `/tmp/onc-rollback-${runId}`,
  confirmFlag: `/tmp/onc-confirmed-${runId}`,
  watchdogPath: `/tmp/onc-watchdog-${runId}.sh`,
  pidFile: `/tmp/onc-watchdog-${runId}.pid`,
  sleepPidFile: `/tmp/onc-watchdog-${runId}.sleep`,
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
  revertCommands = [],
  mode = "reload-then-reboot",
  recoverSeconds = 60,
  reloadWireless = false,
}: {
  runId: string;
  timeoutSeconds: number;
  filesToRestore: string[];
  filesToDelete: string[];
  packagesToUninstallOnRollback: string[];
  /**
   * Discards staged UCI changes as part of the rollback. Restoring
   * /etc/config is not enough on its own: every UCI read applies the deltas in
   * /tmp/.uci, so a run that died mid-configure with changes staged would have
   * its `reload_config` below read the *new* values straight back out and
   * re-apply the config the rollback just undid.
   */
  revertCommands?: string[];
  mode?: RollbackMode;
  /** How long to wait for the tool to reconnect after reverting. */
  recoverSeconds?: number;
  reloadWireless?: boolean;
}) => {
  const {
    rollbackDir,
    confirmFlag,
    watchdogPath,
    pidFile,
    sleepPidFile,
    recoveredFlag,
  } = runPaths(runId);
  const filesArchive = `${rollbackDir}/files.tar`;
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
            .map(shellQuote)
            .join(" ")} 2>/dev/null || true`,
        ]
      : []),
    [
      `cat > ${watchdogPath} <<'${watchdogDelimiter}'`,
      `#!/bin/sh`,
      // Recorded by the watchdog itself, so confirming can kill it during its
      // sleep rather than relying on it noticing a flag afterwards.
      `echo $$ > ${pidFile}`,
      // Sleep in the background and record it, so a failure elsewhere in the
      // run can end the wait early (rollBackNowCommand) and have the rollback
      // below start immediately rather than when the window runs out.
      `sleep ${timeoutSeconds} & echo $! > ${sleepPidFile}; wait $!`,
      `if [ -f ${confirmFlag} ]; then rm -rf ${rollbackDir} ${confirmFlag} ${recoveredFlag} ${watchdogPath} ${pidFile} ${sleepPidFile}; exit 0; fi`,
      `logger -t onc "provision not confirmed within ${timeoutSeconds}s, rolling back [${mode}]"`,
      // Stage the restored copy first, then swap. Doing `mv` before `cp`
      // meant a failed copy — an overlay full from `apk add`, which is exactly
      // when rollbacks fire — rebooted the device with no /etc/config at all,
      // the one failure needing physical recovery.
      `rm -rf /etc/config.onc-new /etc/config.onc-failed`,
      `if cp -a ${rollbackDir}/config /etc/config.onc-new; then mv /etc/config /etc/config.onc-failed && mv /etc/config.onc-new /etc/config; else logger -t onc "rollback: could not stage the config snapshot, leaving current config in place"; fi`,
      // Files this run created did not exist before, so remove them.
      ...filesToDelete.map((path) => `rm -f ${shellQuote(path)}`),
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
            `apk del ${packagesToUninstallOnRollback
              .map(shellQuote)
              .join(
                " "
              )} >/dev/null 2>&1 || logger -t onc "rollback could not remove newly installed packages"`,
          ]
        : []),
      // Reinstall from the .apk files staged before anything was removed.
      // --repositories-file /dev/null keeps this entirely offline.
      `if ls ${rollbackDir}/packages/*.apk >/dev/null 2>&1; then apk add --allow-untrusted --repositories-file /dev/null ${rollbackDir}/packages/*.apk >/dev/null 2>&1 || logger -t onc "rollback could not reinstall removed packages"; fi`,
      // Drop staged UCI changes too. The restore above only puts the files
      // back, but every UCI read applies the deltas in /tmp/.uci on top, so
      // without this the reload below reads the new values straight back out
      // and re-applies exactly the config being rolled back.
      ...revertCommands,
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
            `    rm -rf ${rollbackDir} ${confirmFlag} ${recoveredFlag} ${watchdogPath} ${pidFile} ${sleepPidFile}`,
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
export const prepareRollbackCommands = (runId: string) => {
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
export const stagePackagesForRollback = async ({
  ssh,
  rollbackDir,
  packages,
}: {
  ssh: Session;
  rollbackDir: string;
  packages: string[];
}) => {
  if (packages.length === 0) {
    return { staged: 0 };
  }

  const dir = `${rollbackDir}/packages`;
  await ssh.execCommand(`mkdir -p ${dir}`);
  await ssh.execCommand(
    `apk fetch --output ${dir} ${packages.map(shellQuote).join(" ")}`
  );

  return { staged: await runProbe(ssh, stagedPackageCount(dir)) };
};

/**
 * Start an armed rollback now instead of when its window runs out: end the
 * watchdog's sleep, and it carries on into the restore exactly as if the
 * window had closed. Used when another device in the same run failed, so
 * this one's committed change must be undone too.
 */
export const rollBackNowCommand = (runId: string) =>
  `kill "$(cat ${runPaths(runId).sleepPidFile} 2>/dev/null)" 2>/dev/null; true`;
