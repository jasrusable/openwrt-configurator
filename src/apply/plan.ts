// Plan: verify the device and work out everything the run will do. Changes nothing.
import {
  boardJson as boardJsonProbe,
  configNames,
  serviceTriggers,
  installedPackages as installedPackagesProbe,
  managedFiles as managedFilesProbe,
  missingFiles,
  packageSpace,
  pendingChanges as pendingChangesProbe,
  Probe,
  removalCascade as removalCascadeProbe,
  runProbe,
  runProbes,
} from "../deviceProbes";
import { deviceTmp, runDirName, watchdogPidFile } from "../agent/paths";
import {
  getPackagesToRemove,
  hookCommands,
  managedFilesManifest,
  packagesToAdd,
  prepareRecords,
  seededConfigPaths,
  servicesRecords,
} from "../getDeviceScript";
import { readDeviceNow, stateHash } from "../deviceState";
import { err, ok } from "../result";
import { knownConfigs } from "./knownConfigs";
import { DeviceRun, DeviceRunOptions, failure, guarded, PhaseResult, step } from "./run";

type ArmedRun = { run: string; seconds: number; recover: number };

/**
 * Other runs' watchdogs alive on the device (one stopped or lost before it
 * confirmed, from this machine or another): each one's run, the seconds
 * before it fires on the device's own clock (negative: restoring now), and
 * how long it then waits to be reached before rebooting.
 */
export const armedRuns: Probe<ArmedRun[]> = {
  command: [
    `for f in ${deviceTmp}/${runDirName}*/${watchdogPidFile}; do`,
    // One confirmed restores nothing: it stands down as it wakes (a disarm that could not end its sleep).
    `[ -f "$f" ] || continue; d=\${f%/*}; { [ -f "$d/confirmed" ] && [ ! -f "$d/restoring" ]; } && continue; p=$(cat "$f")`,
    // Its pid still a watchdog: a pid is reused once its process ends.
    `tr '\\0' '\\n' < "/proc/$p/cmdline" 2>/dev/null | grep -qx watchdog || continue`,
    `echo "\${d##*/${runDirName}} $(( $(cat "$d/fires" 2>/dev/null || date +%s) - $(date +%s) )) $(cat "$d/recover" 2>/dev/null || echo 60)"`,
    "done",
  ].join("\n"),
  parse: ({ stdout }) =>
    stdout.split("\n").flatMap((line) => {
      const match = /^(\S+) (-?\d+) (\d+)$/.exec(line.trim());
      return match ? [{ run: match[1], seconds: Number(match[2]), recover: Number(match[3]) }] : [];
    }),
};

/** Restoring takes a while (packages reinstalled offline): allowed for in the wait said. */
const restoreAllowanceSeconds = 60;

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
      configNames,
      serviceTriggers,
      armed: armedRuns,
    });
    const { boardJson, installedPackages, managedFiles, unseeded } = facts;
    if (deviceModelId !== undefined && boardJson.model?.id !== deviceModelId) {
      return err(
        failure(`Mismatching device model id. Expected ${deviceModelId} but found ${boardJson.model?.id} in /etc/board.json`)
      );
    }

    // Another run's watchdog restores its snapshot at its deadline, over
    // whatever this run would do: never apply under one. Checked on the
    // device, whatever ran that run (killed, another machine) or holds a lock.
    if (facts.armed.length > 0) {
      const seconds = Math.max(...facts.armed.map((a) => Math.max(0, a.seconds) + restoreAllowanceSeconds + a.recover));
      return err(
        failure(
          `${hostname} still has an earlier apply's rollback armed (one never confirmed: stopped, or lost): it puts back the settings from before that apply, then waits to be reached before rebooting onto them. ` +
            `Applying now would be undone by it: apply again in about ${Math.ceil(seconds / 60)} min. Nothing was changed.`
        )
      );
    }

    // Reviewed from what the device held then: one changed since (by hand,
    // another tool, another apply) would have changes nobody saw; and one
    // not in the review was never reviewed.
    if (options.verify && options.verify.hash === undefined) {
      return err(failure(`${hostname} was not in the reviewed changes: review them again. Nothing was changed.`, {}, "plan-stale"));
    }
    if (options.verify && stateHash(await readDeviceNow(ssh, []), options.verify.sha256) !== options.verify.hash) {
      return err(
        failure(`${hostname} changed since its changes were reviewed: review them again. Nothing was changed.`, {}, "plan-stale")
      );
    }

    // A declared config the device lacks, OpenWrt does not ship and the file
    // does not call new is a typo (`firwall`): staged as its own config while
    // the real one would be wiped as undeclared.
    const unknown = Object.keys(state.config).filter(
      (name) => !facts.configNames.includes(name) && !knownConfigs.has(name) && !(state.newConfigs ?? []).includes(name)
    );
    if (unknown.length > 0) {
      return err(
        failure(
          `${hostname}: ${unknown.map((name) => `"${name}"`).join(", ")} ${unknown.length === 1 ? "is" : "are"} not a config on the device, nor one OpenWrt ships: a typo? A custom package's config the device does not have yet goes in "new_configs". Nothing was changed.`
        )
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

    // Refused here, before anything changes, rather than with the flash full
    // halfway through apk add (a small-flash device and a role's packages).
    const adding = packagesToAdd({ state, installedPackages });
    if (adding.length > 0) {
      const space = await runProbe(ssh, packageSpace({ add: adding, remove: packagesToRemove }));
      if (!space) {
        console.warn(`  ${hostname}: could not work out what the new packages take of the flash; installing without checking.`);
      } else if (space.needKb > space.freeKb) {
        const mib = (kb: number) => `${(kb / 1024).toFixed(1)} MiB`;
        return err(
          failure(
            `${hostname} has too little room for the packages this run installs (${adding.join(", ")}): they take about ${mib(space.needKb)}, and it has ${mib(space.freeKb)} free. Nothing was changed.`
          )
        );
      }
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
      serviceRecords: servicesRecords(state, facts.serviceTriggers, [...adding, ...removalCascade]),
      servicesToCheck: (state.services || []).filter((s) => s.running).map((s) => s.name),
      // `uci revert` undoes staged UCI changes and nothing else. Packages,
      // written or removed files and configs seeded into /etc/config are on
      // disk once done, and only the watchdog can undo those.
      hasIrreversibleSteps:
        packagesToRemove.length > 0 ||
        adding.length > 0 ||
        (state.files || []).length > 0 ||
        managedFiles.length > 0 ||
        unseeded.length > 0,
    };
    return ok(run);
  });
