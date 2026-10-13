// Commit: `uci commit` each changed config, the commit's marker, then reload_config.
import * as agent from "../agent";
import { err, ok } from "../result";
import { revertStaged } from "./configure";
import { DeviceRun, failure, guarded, PhaseResult, step } from "./run";

const dropped = () => console.log(`Connection dropped during commit (expected when network config changes).`);

export const commitDevice = async (run: DeviceRun): Promise<PhaseResult> => {
  const { ssh, hostname, runId, finaliseRecords } = run;
  if (!finaliseRecords) throw new Error(`${hostname}: commitDevice before configureDevice`);
  return guarded(
    async () => {
      // Committing can drop the connection, since reload_config reconfigures
      // the network we are connected over. That is expected, not a failure,
      // and node-ssh reports it as a command with no exit status rather than
      // a rejection: treating it as failed would revert a commit that worked,
      // in exactly the case this exists for. Confirming finds out (the marker).
      console.log(`Committing ${hostname}...`);
      step(run, "committing");
      const finalised = await agent.call(ssh, agent.finalise(runId, finaliseRecords));
      if (!finalised.ok) {
        dropped();
        return ok(run);
      }
      if (finalised.value.done) return ok(run);
      console.error(`Failed to commit, at: ${finalised.value.step}\n${finalised.value.stderr}`);
      // `uci commit` may have persisted before the failing step, and `uci
      // revert` cannot undo a commit: only the watchdog can.
      await revertStaged(run);
      return err(failure(`Failed to commit configuration on ${hostname}.`, { committed: true }));
    },
    { committed: true }
  );
};
