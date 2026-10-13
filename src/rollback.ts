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
  /**
   * The config snapshot again, on flash: /tmp, and the watchdog with it, is
   * gone if the device restarts (a locked-out user pulling the plug), so a
   * boot script restores this one if the run was never confirmed.
   */
  bootDir: `${bootRollbackRoot}/${runId}`,
  /** Written once every `uci commit` succeeded: a commit the link dropped during is told from a whole one. */
  committedFlag: `/tmp/onc-committed-${runId}`,
});

const bootRollbackRoot = "/etc/onc/rollback";

/** Whether procd runs service $s: what the apply's own start step goes by. */
const procdKnows = `ubus call service list '{"name":"'"$s"'"}' 2>/dev/null | grep -q "^[[:space:]]*\\"$s\\""`;

/**
 * Run early at boot (before the network): restore the config of an apply that
 * was never confirmed, the oldest if several, then drop them all. Copied
 * first and swapped after, as the watchdog does, so a full overlay never
 * leaves the device without /etc/config.
 */
const bootRollbackScript = `#!/bin/sh /etc/rc.common
# openwrt-configurator: the device restarted inside an apply's rollback window.
START=11
start() { return 0; }
boot() {
  for d in $(ls -dtr ${bootRollbackRoot}/*/ 2>/dev/null); do
    [ -d "$d/config" ] || continue
    rm -rf /etc/config.onc-new /etc/config.onc-failed
    if cp -a "$d/config" /etc/config.onc-new; then
      mv /etc/config /etc/config.onc-failed && mv /etc/config.onc-new /etc/config
      # The system log is not running this early: the kernel's is.
      echo "onc: restarted inside an unconfirmed apply's rollback window: its config restored" > /dev/kmsg
    fi
    break
  done
  rm -rf ${bootRollbackRoot}
}
`;

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
  restartAfterRestore = [],
  services = [],
}: {
  /**
   * The services this run enables, disables, starts or stops: put back as
   * they were (enabled at boot, and running or not), as /etc/config holds
   * neither.
   */
  services?: string[];
  /**
   * Services restarted once the restored config is reloaded: a reload keeps
   * the devices a service had (odhcpd went on sending to a LAN device the
   * rollback removed, and the whole LAN lost IPv6; seen on a real router).
   */
  restartAfterRestore?: string[];
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
    bootDir,
    committedFlag,
  } = runPaths(runId);
  const filesArchive = `${rollbackDir}/files.tar`;
  // Derived rather than hardcoded, for the same reason the file writer derives
  // its own: a caller-supplied path could otherwise close the heredoc early.
  const watchdogDelimiter = heredocDelimiter(
    [...filesToDelete, ...packagesToUninstallOnRollback].join("\n"),
    "ONC_WATCHDOG"
  );

  const bootDelimiter = heredocDelimiter(bootRollbackScript, "ONC_BOOT_ROLLBACK");
  return [
    `cp -a /etc/config ${rollbackDir}/config`,
    // On flash too, with the boot script that restores it (see bootDir). A
    // flash too full for it only loses this extra: the watchdog still covers
    // every run that does not restart the device.
    `cat > /etc/init.d/onc-rollback <<'${bootDelimiter}'\n${bootRollbackScript}${bootDelimiter}`,
    `chmod 0755 /etc/init.d/onc-rollback && /etc/init.d/onc-rollback enable`,
    `{ mkdir -p ${bootDir} && cp -a /etc/config ${bootDir}/config; } || { rm -rf ${bootDir}; logger -t onc "no room on flash for a boot-time rollback copy"; }`,
    // Which services start at boot, and which of this run's are running.
    `tar -cf ${rollbackDir}/rc.d.tar -C /etc/rc.d . 2>/dev/null || true`,
    ...(services.length
      ? [
          `for s in ${services.map(shellQuote).join(" ")}; do ${procdKnows} && echo "$s"; done > ${rollbackDir}/running; true`,
        ]
      : []),
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
      `if [ -f ${confirmFlag} ]; then rm -rf ${rollbackDir} ${bootDir} ${confirmFlag} ${recoveredFlag} ${committedFlag} ${watchdogPath} ${pidFile} ${sleepPidFile}; exit 0; fi`,
      // Past the point of no return: a disarm from now on must not kill this
      // (half a restore is worse than either config), and must say it fired.
      `touch ${rollbackDir}/restoring`,
      `logger -t onc "provision not confirmed within ${timeoutSeconds}s, rolling back [${mode}]"`,
      // Stage the restored copy first, then swap. Doing `mv` before `cp`
      // meant a failed copy — an overlay full from `apk add`, which is exactly
      // when rollbacks fire — rebooted the device with no /etc/config at all,
      // the one failure needing physical recovery.
      `rm -rf /etc/config.onc-new /etc/config.onc-failed`,
      `if cp -a ${rollbackDir}/config /etc/config.onc-new; then mv /etc/config /etc/config.onc-failed && mv /etc/config.onc-new /etc/config; else logger -t onc "rollback: could not stage the config snapshot, leaving current config in place"; fi`,
      // Restored: a restart from here on boots the old config anyway.
      `rm -rf ${bootDir}`,
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
            // Boot links back as they were, and this run's services running
            // (or not) as they were: /etc/config holds neither.
            // Extracted beside it and swapped, so a failed extract never leaves the device without one.
            `if [ -f ${rollbackDir}/rc.d.tar ] && rm -rf /etc/rc.d.onc-new && mkdir /etc/rc.d.onc-new && tar -xf ${rollbackDir}/rc.d.tar -C /etc/rc.d.onc-new; then rm -rf /etc/rc.d.onc-old; mv /etc/rc.d /etc/rc.d.onc-old && mv /etc/rc.d.onc-new /etc/rc.d && rm -rf /etc/rc.d.onc-old; fi`,
            ...(services.length
              ? [
                  `for s in ${services.map(shellQuote).join(" ")}; do [ -x "/etc/init.d/$s" ] || continue; if grep -qx "$s" ${rollbackDir}/running 2>/dev/null; then ${procdKnows} || "/etc/init.d/$s" start; else ! ${procdKnows} || "/etc/init.d/$s" stop; fi; done >/dev/null 2>&1; true`,
                ]
              : []),
            // Once the network has settled on the restored devices.
            ...(restartAfterRestore.length
              ? [
                  `sleep 5`,
                  `for s in ${restartAfterRestore.map(shellQuote).join(" ")}; do [ -x "/etc/init.d/$s" ] && "/etc/init.d/$s" restart >/dev/null 2>&1; done; true`,
                ]
              : []),
            // A reload is not proof the operator can reach the device again, so
            // wait for them to get back in and say so. Rebooting without this
            // check would make the reload pointless; skipping the reboot
            // without it would remove the only guaranteed recovery.
            `i=0`,
            `while [ $i -lt ${recoverSeconds} ]; do`,
            `  if [ -f ${recoveredFlag} ]; then`,
            `    logger -t onc "revert restored access, no reboot needed"`,
            `    rm -rf ${rollbackDir} ${confirmFlag} ${recoveredFlag} ${committedFlag} ${watchdogPath} ${pidFile} ${sleepPidFile}`,
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
  // Its saved pid, if it is still a sleep: a pid is reused once its process ends.
  `s=$(cat ${runPaths(runId).sleepPidFile} 2>/dev/null); [ -n "$s" ] && [ "$(cat /proc/$s/comm 2>/dev/null)" = sleep ] && kill "$s" 2>/dev/null; true`;
