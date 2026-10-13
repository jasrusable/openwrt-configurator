// Plan: verify the device and work out everything the run will do. Changes nothing.
import {
  boardJson as boardJsonProbe,
  installedPackages as installedPackagesProbe,
  managedFiles as managedFilesProbe,
  missingFiles,
  pendingChanges as pendingChangesProbe,
  removalCascade as removalCascadeProbe,
  runProbe,
  runProbes,
} from "../deviceProbes";
import {
  getPackagesToRemove,
  hookCommands,
  managedFilesManifest,
  packagesToAdd,
  prepareRecords,
  seededConfigPaths,
  servicesRecords,
} from "../getDeviceScript";
import { err, ok } from "../result";
import { DeviceRun, DeviceRunOptions, failure, guarded, PhaseResult, step } from "./run";

/** Unique per device: several devices are armed within the same second. */
const newRunId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const planDevice = (options: DeviceRunOptions): Promise<PhaseResult> =>
  guarded(async () => {
    const { ssh, hostname, ipAddress, deviceModelId, state } = options;
    console.log(`Planning ${hostname} @ ${ipAddress}...`);
    step(options, "planning");

    // One round trip for everything the plan needs from the device.
    const facts = await runProbes(ssh, {
      boardJson: boardJsonProbe,
      installedPackages: installedPackagesProbe,
      pendingChanges: pendingChangesProbe,
      managedFiles: managedFilesProbe(managedFilesManifest),
      unseeded: missingFiles(seededConfigPaths(state)),
    });
    const { boardJson, installedPackages, managedFiles, unseeded } = facts;
    if (deviceModelId !== undefined && boardJson.model?.id !== deviceModelId) {
      return err(
        failure(`Mismatching device model id. Expected ${deviceModelId} but found ${boardJson.model?.id} in /etc/board.json`)
      );
    }

    const packagesToRemove = getPackagesToRemove({ state, installedPackages });
    const removalCascade = packagesToRemove.length > 0 ? await runProbe(ssh, removalCascadeProbe(packagesToRemove)) : [];
    if (packagesToRemove.length > 0) {
      const extra = removalCascade.filter((p) => !packagesToRemove.includes(p));
      console.warn(
        `\n  !! ${hostname}: config removes ${packagesToRemove.join(", ")}.\n` +
          `     With --rdepends that takes ${removalCascade.length} package(s) in total:\n` +
          `       ${removalCascade.join(" ")}\n` +
          (extra.length > 0 ? `     ${extra.length} of these are pulled in as dependents, not named in your config.\n` : "")
      );
    }

    // The run starts from committed state (the agent's revert), so say
    // what it is about to throw away. Counts only: staged values can be secrets.
    const pending = Object.entries(facts.pendingChanges);
    if (pending.length > 0) {
      console.warn(
        `  ${hostname}: discarding uncommitted UCI changes in ` +
          pending.map(([pkg, count]) => `${pkg} (${count})`).join(", ") +
          ` (LuCI's unsaved changes are kept).`
      );
    }

    const run: DeviceRun = {
      ...options,
      runId: newRunId(),
      installedPackages,
      managedFiles,
      removalCascade,
      prepareRecords: prepareRecords({ state, installedPackages }),
      // Their own step, not part of finalise: `reload_config` is what can
      // sever the link, and a hook after it in the same verb dies to SIGPIPE
      // the moment dropbear exits. These run over a new session.
      hooks: hookCommands(state),
      serviceRecords: servicesRecords(state),
      servicesToCheck: (state.services || []).filter((s) => s.running).map((s) => s.name),
      // `uci revert` undoes staged UCI changes and nothing else. Packages,
      // written or removed files and configs seeded into /etc/config are on
      // disk once done, and only the watchdog can undo those.
      hasIrreversibleSteps:
        packagesToRemove.length > 0 ||
        packagesToAdd({ state, installedPackages }).length > 0 ||
        (state.files || []).length > 0 ||
        managedFiles.length > 0 ||
        unseeded.length > 0,
    };
    return ok(run);
  });
