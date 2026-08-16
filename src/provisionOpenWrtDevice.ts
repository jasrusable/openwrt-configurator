import { OpenWrtState } from "./openWrtConfigSchema";
import { NodeSSH } from "node-ssh";
import {
  finaliseCommands,
  getDeviceScript,
  getPackagesToRemove,
  getRemovalCascade,
  getRevertCommands,
  managedFilesManifest,
} from "./getDeviceScript";
import { execScript } from "./execScript";
import { getBoardJson, getInstalledPackages, getManagedFiles } from "./utils";

const reconnectIntervalMs = 3000;

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
});

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
 * session that spawned it.
 *
 * Scope, in order of how well it rewinds:
 *  - /etc/config: snapshotted and restored wholesale.
 *  - Managed files: pre-existing ones are archived and restored; ones this run
 *    creates are deleted.
 *  - Packages installed by this run: removed again (needs no network).
 *  - Packages REMOVED by this run: reinstalled from .apk files staged before
 *    the removal, offline.
 *
 * Killing the CLI between arming and confirming leaves the watchdog running,
 * so the device will restore and reboot on its own.
 */
export const armWatchdogCommands = ({
  runId,
  timeoutSeconds,
  filesToRestore,
  filesToDelete,
  packagesToUninstallOnRollback,
}: {
  runId: string;
  timeoutSeconds: number;
  filesToRestore: string[];
  filesToDelete: string[];
  packagesToUninstallOnRollback: string[];
}) => {
  const { rollbackDir, confirmFlag, watchdogPath } = runPaths(runId);
  const filesArchive = `${rollbackDir}/files.tar`;
  const quote = (path: string) => `'${path.replace(/'/g, `'\\''`)}'`;

  return [
    `rm -rf ${rollbackDir} ${confirmFlag}`,
    `mkdir -p ${rollbackDir}`,
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
      `cat > ${watchdogPath} <<'ONC_WATCHDOG'`,
      `#!/bin/sh`,
      `sleep ${timeoutSeconds}`,
      `if [ -f ${confirmFlag} ]; then rm -rf ${rollbackDir} ${confirmFlag} ${watchdogPath}; exit 0; fi`,
      `logger -t onc "provision not confirmed within ${timeoutSeconds}s, rolling back and rebooting"`,
      `rm -rf /etc/config.onc-failed`,
      `mv /etc/config /etc/config.onc-failed`,
      `cp -a ${rollbackDir}/config /etc/config`,
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
      `reboot`,
      `ONC_WATCHDOG`,
    ].join("\n"),
    `chmod 0755 ${watchdogPath}`,
    `setsid ${watchdogPath} </dev/null >/dev/null 2>&1 &`,
  ];
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
  const configureCommands = allCommands.slice(
    0,
    allCommands.length - finaliseCommands.length
  );

  const revertCommands = getRevertCommands(state);
  const revert = async (session: NodeSSH) => {
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
      // Nothing was committed, so the watchdog must not reboot the device.
      await session.execCommand(`touch ${confirmFlag}`);
      console.error(`Reverted.`);
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
    const filesToRestore = [
      ...new Set([...previouslyManagedFiles, managedFilesManifest]),
    ];
    const filesToDelete = newFilePaths.filter(
      (path) => !previouslyManagedFiles.includes(path)
    );
    const packagesToUninstallOnRollback = (state.packagesToInstall || [])
      .map((p) => p.packageName)
      .filter((name) => !installedPackages.includes(name));

    console.log(
      `Arming rollback (restores /etc/config` +
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
      }),
    });
    if (!armed.ok) {
      throw new Error(
        `Failed to arm rollback on ${hostname}. Command: ${armed.command}\n${armed.stderr}`
      );
    }

    // After arming (which creates the rollback dir) but before anything is
    // removed, while the link is still up.
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
  }

  console.log(`Setting configuration (${configureCommands.length} commands)...`);
  const configured = await execScript({ ssh, commands: configureCommands });
  if (!configured.ok) {
    console.error(
      `Command ${configured.failedIndex + 1}/${configureCommands.length} failed: ${configured.command}`
    );
    console.error(configured.stderr);
    await revert(ssh);
    throw new Error(
      `Failed to provision ${hostname}. Aborting and rolling back.`
    );
  }
  console.log("Configuration set.");

  // The watchdog is counting from the moment it was armed, so the window to get
  // back in is measured from here, not from whenever the commit finishes.
  const confirmDeadline = Date.now() + confirmTimeoutSeconds * 1000;

  // Committing can drop the connection, since reload_config reconfigures the
  // network we are connected over. A dropped connection is therefore expected
  // and not an error — but a command that genuinely fails while the connection
  // is still up is, and must not be mistaken for success.
  console.log("Committing...");
  let commitFailed: string | undefined;
  try {
    const finalised = await execScript({ ssh, commands: finaliseCommands });
    if (!finalised.ok) {
      commitFailed = `${finalised.command}\n${finalised.stderr}`;
    }
  } catch (e) {
    console.log(
      `Connection dropped during commit (expected when network config changes).`
    );
  }

  if (commitFailed) {
    console.error(`Failed to commit: ${commitFailed}`);
    await revert(ssh);
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
    throw new Error(
      `Could not reconnect to ${hostname} after commit. The device will restore ` +
        `its previous configuration and reboot shortly.`
    );
  }

  await confirmSession.execCommand(`touch ${confirmFlag}`);
  console.log("Confirmed. Provisioning completed.");
  confirmSession.dispose();
};
