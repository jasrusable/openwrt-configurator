// After disarming: the config is live everywhere, which is what the hooks
// need, and a hook failing should not roll back a healthy network.
import * as agent from "../agent";
import { notRunning, runProbe, servicesSettled } from "../deviceProbes";
import { hookRecords } from "../getDeviceScript";
import { Session } from "../platform";
import { attempt, err, messageOf, ok, Result } from "../result";
import { commandLabel, DeviceRun, scrubbed } from "./run";

/**
 * The `run_after_reload` hooks, over a session known to be alive. One failing
 * does not undo the provision (the config is committed and live; a reboot
 * would apply it): it is said, and the run ends "applied, with a problem".
 */
export const runPostReloadHooks = async (run: DeviceRun, session: Session): Promise<Result<void, string>> => {
  const { hooks, hostname } = run;
  if (hooks.length === 0) return ok(undefined);
  console.log(`Running ${hooks.length} post-reload hook(s) on ${hostname}...`);
  const hooked = await agent.call(session, agent.hooks(run.runId, hookRecords(hooks)));
  const live = `${hostname} was provisioned and its configuration is live, but`;
  if (!hooked.ok) return err(`${live} its run_after_reload hooks could not be run (${hooked.error.message}).`);
  const steps = hooked.value;
  if (steps.done) {
    console.log("Post-reload hooks completed.");
    return ok(undefined);
  }
  // "hook <n>": named by its command's first words, never its values.
  const index = Number(/^hook (\d+)$/.exec(steps.step)?.[1]) - 1;
  const which = hooks[index] === undefined ? steps.step : commandLabel(hooks[index]);
  return err(`${live} a run_after_reload hook failed: ${which}\n${scrubbed(run, steps.stderr)}`);
};

/**
 * Once services settle, those that must be running are: what is not, in
 * words. A warning, not a failure: rolling a healthy network back for one
 * daemon would do more harm than the daemon.
 */
export const checkServices = async (run: DeviceRun, session: Session): Promise<string[]> => {
  const { servicesToCheck, hostname } = run;
  if (servicesToCheck.length === 0) return [];
  const down = await attempt(
    async () => {
      await runProbe(session, servicesSettled(10));
      return runProbe(session, notRunning(servicesToCheck));
    },
    messageOf
  );
  return down.ok
    ? down.value.map(({ name, missing }) => `${hostname}: ${name} is ${missing ? "not installed" : "not running"}`)
    : [`${hostname}: its services could not be checked (${down.error})`];
};
