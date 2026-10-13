// Configure: make the device's staged config exactly the declared one. Install
// and remove packages (which can add config), read what the device then has,
// wipe it and set the declared config in one batch, then read it back and
// check. Nothing is committed here, so a failure is undone by a revert, plus
// the watchdog for packages and files.
import { keepText } from "../plan/types";
import * as agent from "../agent";
import { runProbe, uciConfigs } from "../deviceProbes";
import { finaliseRecords, stageRecords } from "../getDeviceScript";
import { err, ok, Result } from "../result";
import { declaredConfigs, isKept, UciConfigs, unmatchedKeeps, verifyConfigs } from "../engine/uci";
import { DeviceRun, failure, guarded, PhaseFailure, PhaseResult, step } from "./run";

/**
 * Discard this run's staged UCI changes. Whether the watchdog stays armed is
 * the run's call (provisionNetwork): only it can undo packages and files.
 * Never fails: the failure that led here is what the user needs to see.
 */
export const revertStaged = async (run: DeviceRun) => {
  console.error(`Reverting ${run.hostname}...`);
  const reverted = await agent.call(run.ssh, agent.revert(run.runId));
  if (!reverted.ok) console.error(`Could not revert ${run.hostname}: ${reverted.error.message}`);
  else if (!reverted.value.done) console.error(`Could not revert ${run.hostname}: ${reverted.value.stderr}`);
};

/**
 * Nothing committed; packages or files may have changed, which only the
 * watchdog undoes. So may anything, if the link dropped (`unknown`): what the
 * device did is then not known, and its revert ran over a dead session.
 */
const configureFailure = (run: DeviceRun, message: string, { unknown = false } = {}) =>
  failure(message, { leftArmed: run.hasIrreversibleSteps || unknown });

/**
 * One of the agent's step verbs: done, or the failure it leaves. A link that
 * dropped gave no answer, so what the device did is not known.
 */
const runSteps = async (run: DeviceRun, verb: agent.Verb<agent.Steps>): Promise<Result<void, PhaseFailure>> => {
  const answer = await agent.call(run.ssh, verb);
  if (!answer.ok) {
    // A link that dropped, or a step with no answer within its time limit:
    // either way what the device did is not known.
    return err(configureFailure(run, `Lost the connection to ${run.hostname} while configuring it (${answer.error.message}).`, { unknown: true }));
  }
  if (answer.value.done) return ok(undefined);
  console.error(`${run.hostname} failed at: ${answer.value.step}`);
  if (answer.value.stderr) console.error(answer.value.stderr);
  return err(configureFailure(run, `Failed to configure ${run.hostname}.`));
};

/** The device's config, staged changes included; an unreadable config that is not kept refuses the run. */
const readConfigs = async (run: DeviceRun): Promise<Result<UciConfigs, PhaseFailure>> => {
  const keep = run.state.keep;
  const { configs, unreadable } = await runProbe(run.ssh, uciConfigs);
  const blocking = unreadable.filter((configKey) => !isKept(keep, configKey));
  return blocking.length > 0
    ? err(
        configureFailure(
          run,
          `uci cannot read ${blocking.map((configKey) => `/etc/config/${configKey}`).join(", ")} on ${run.hostname}, ` +
            `so it cannot be reset. Fix or delete it, or add "${blocking[0]}.*" to configs_to_not_reset.`
        )
      )
    : ok(configs);
};

const configureSteps = async (run: DeviceRun): Promise<PhaseResult> => {
  const { hostname, state } = run;
  const keep = state.keep;

  const prepared = await runSteps(run, agent.prepare(run.runId, run.prepareRecords));
  if (!prepared.ok) return prepared;

  const current = await readConfigs(run);
  if (!current.ok) return current;
  const unmatched = unmatchedKeeps(keep, current.value);
  if (unmatched.length > 0) {
    console.warn(
      `  ${hostname}: configs_to_not_reset ${unmatched.map((entry) => `"${keepText(entry)}"`).join(", ")} ` +
        `match${unmatched.length === 1 ? "es" : ""} no config on the device.`
    );
  }

  console.log(`Setting configuration on ${hostname}...`);
  step(run, "configuring");
  const staged = await runSteps(run, agent.stage(run.runId, stageRecords({ state, current: current.value, managedFiles: run.managedFiles })));
  if (!staged.ok) return staged;

  // The guarantee, checked rather than assumed: whatever the wipe missed or
  // something else changed meanwhile shows up here, before anything commits.
  const actual = await readConfigs(run);
  if (!actual.ok) return actual;
  const problems = verifyConfigs({ actual: actual.value, declared: declaredConfigs(state.config), keep });
  if (problems.length > 0) {
    console.error(problems.map((problem) => `  ${problem}`).join("\n"));
    return err(
      configureFailure(
        run,
        `The staged configuration on ${hostname} does not match the config file (${problems.length} difference(s)). Nothing was committed.`
      )
    );
  }
  console.log("Configuration set and verified.");
  return ok({ ...run, finaliseRecords: finaliseRecords({ state, current: current.value }) });
};

export const configureDevice = async (run: DeviceRun): Promise<PhaseResult> => {
  // Anything thrown (a dropped session, an unreadable answer): what the device
  // did is unknown, so only its watchdog can be trusted to put it back.
  const result = await guarded(() => configureSteps(run), { leftArmed: true });
  if (!result.ok) await revertStaged(run);
  return result;
};

/**
 * Configuring runs inside the watchdog's window, so on a slow link or a large
 * config it can eat it, and committing with too little left would let the
 * watchdog fire mid-reconnect and roll back a good provision. So commit only
 * with time left to confirm every device committed so far and this one,
 * before the earliest watchdog fires: none is disarmed until all are
 * confirmed, so that one sets the deadline for them all.
 */
export const ensureTimeToConfirm = async (run: DeviceRun, earliestDeadline: number, confirmsLeft = 1): Promise<PhaseResult> => {
  const { minimumConfirmWindowMs } = run.timing;
  if (earliestDeadline - run.now() >= minimumConfirmWindowMs * confirmsLeft) return ok(run);
  await revertStaged(run);
  return err(
    configureFailure(
      run,
      `Too little of the rollback window is left to confirm ${run.hostname} ` +
        `(less than ${minimumConfirmWindowMs / 1000}s). Nothing was committed on it. Re-run with a larger --confirm-timeout.`
    )
  );
};
