// What every command is built from: the platform it runs on, the confirm
// window's timing, and where the built web UI is by default.
import { confirmTiming } from "../apply/reconnect";
import { where } from "../intent/places";
import { withLocatedAddresses } from "../deviceFacts";
import type { Plan } from "../plan/types";
import { Platform } from "../platform";

export type CliContext = {
  platform: Platform;
  timing: ReturnType<typeof confirmTiming>;
  uiDir: string;
};

/**
 * Every device located (src/locate.ts) before any is touched; one that cannot
 * be (never pinned and only at a name, or not where it should be) stops the
 * run here, by name.
 */
export const locatedOrRefused = async (plan: Plan, intentPath: string, platform: Platform) => {
  const located = await withLocatedAddresses(plan, intentPath, platform);
  if (located.unreached.length) {
    throw new Error(
      `Not applied: ${located.unreached.map((u) => `${u.hostname} could not be found safely (${u.error})`).join("; ")}. ` +
        `Nothing was changed. A device never adopted can be added in the web UI (${where("hardware", "Add")}).`
    );
  }
  return located;
};

/** A command that ran and did not succeed: its message, and the exit status that says how (src/cli/index.ts's `run`). */
export class CommandFailed extends Error {
  constructor(message: string, readonly exitCode: number) {
    super(message);
  }
}
