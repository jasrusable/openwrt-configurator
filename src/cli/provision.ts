// `provision`: apply a config (an intent file, or a low-level one) to its
// devices, as one change with commit-confirm (src/apply/provisionNetwork.ts);
// with --upgrade, their firmware first (src/firmware/run.ts).
import { ApplyEvent } from "../applyEvents";
import { CommandSpec } from "../args";
import { writeFacts } from "../deviceFacts";
import { readApplyPlan, stampApplied } from "../applyDiff";
import { planText } from "../applyPlanText";
import { parseJson } from "../utils";
import { DeviceSchema } from "../deviceSchema";
import { loadConfigOrThrow } from "../loadConfig";
import { lockoutReason } from "../loginAccess";
import { provisionConfig } from "../apply/provisionConfig";
import { appliedWithProblemsExit, RunResult } from "../apply/outcome";
import { jobEnding } from "../server/provisionJob";
import { chosenDevices, upgradeFirst } from "../firmware/run";
import { forgetUpgrading, selfFlashLimitMs } from "../firmware/self";
import { err } from "../result";
import { CliContext, CommandFailed, locatedOrRefused } from "./context";

/** The exit status for how a run ended: 0 applied, 3 applied with a problem after, 1 anything else. */
const exitCodeOf = (result: RunResult) =>
  result.ok ? 0 : result.error.end === "applied-with-problems" ? appliedWithProblemsExit : 1;

export const provisionCommand = (context: CliContext): CommandSpec => {
  const { platform, timing } = context;
  const provision = provisionWith(context);
  return {
    name: "provision",
    description: "provision configuration to devices",
    args: [{ name: "config-file", description: "config file to provision" }],
    options: [
      {
        flags: "--no-confirm",
        description:
          "skip the commit-confirm rollback (the device will not restore itself if the new config cuts it off)",
      },
      {
        flags: "--rollback <mode>",
        description:
          "how a device recovers if a provision is never confirmed: " +
          "reload-then-reboot (revert, reload services, reboot only if access does not come back), " +
          "reload (never reboot), or reboot (always reboot)",
        parse: (v) => {
          if (!["reload", "reboot", "reload-then-reboot"].includes(v)) {
            throw new Error(
              `--rollback must be one of reload, reboot, reload-then-reboot (got "${v}").`
            );
          }
          return v;
        },
        default: "reload-then-reboot",
      },
      {
        flags: "--events <file>",
        description: "write where each device is, and how the run ended, as JSON lines (what the UI shows)",
      },
      {
        flags: "--job <dir>",
        description: "run as the web UI's apply job (src/server/provisionJob.ts): say how it ended in <dir>; needs --run-id",
      },
      {
        flags: "--run-id <id>",
        description: "the job's id, on its command line so its process can be told apart from any other",
      },
      {
        flags: "--facts-for <intent>",
        description: "keep each device's facts (model, ports, radios) beside this intent file, as the UI reads them",
      },
      {
        flags: "--confirm-timeout <seconds>",
        description:
          "seconds to reconnect and confirm before the device rolls back",
        parse: (v) => {
          const seconds = parseInt(v, 10);
          // An unparsed value would reach the device as `sleep NaN`.
          if (
            !Number.isFinite(seconds) ||
            seconds < timing.minimumConfirmTimeoutSeconds
          ) {
            throw new Error(
              `--confirm-timeout must be a whole number of seconds, at least ${timing.minimumConfirmTimeoutSeconds} (got "${v}").`
            );
          }
          return seconds;
        },
        default: 90,
      },
      {
        flags: "--plan",
        description: "print what applying would change, read from the devices now, and apply nothing (an intent file)",
      },
      {
        flags: "--verify <file>",
        description:
          "each device's state hash from a reviewed plan, as JSON: a device that differs stops the run before anything changes",
      },
      {
        flags: "--upgrade <devices>",
        description:
          "first upgrade these devices' firmware (comma-separated, or all) to the release the settings give them, " +
          "settings kept, one at a time with the router last; then apply (an intent file)",
      },
      {
        flags: "--accept-downgrade",
        description:
          "with --upgrade: allow moving a device back to an older release (within its series, settings kept; " +
          "to an older series, only its SSH keys kept, then the whole config applied for that release)",
      },
      {
        flags: "--accept-new-series",
        description: "with --upgrade: allow a move into an OpenWrt series this app has not been checked against (settings carried over unchecked)",
      },
      {
        flags: "--identity <path>",
        description:
          "SSH private key (like ssh -i). Overrides ssh_auth.private_key_path. Password is optional when a key or agent is used.",
      },
    ],
    action: async ([configPath], options) => {
      if (options.plan) return printPlan(platform, configPath);
      if (!options.job !== !options.runId) throw new Error("--job and --run-id go together.");
      // As the UI's job: how it ends is kept, however it ends, short of being killed outright.
      const end = options.job ? jobEnding(platform, options.job as string, options.runId as string) : undefined;
      if (end) platform.onStop((signal) => end({ signal }));
      let exitCode = 1;
      try {
        const result = await provision([configPath], options);
        exitCode = exitCodeOf(result);
        if (!result.ok) throw new CommandFailed(result.error.message, exitCode);
      } finally {
        // However it ended: thrown before reaching a device (a config that
        // does not load, a device not found safely) is a failure too.
        end?.({ exitCode });
      }
    },
  };
};

/** `--plan`: the change plan (src/applyPlan.ts), in words. */
const printPlan = async (platform: CliContext["platform"], configPath: string) => {
  const plan = await readApplyPlan({ intentPath: configPath, platform, now: Date.now });
  if (!plan.ok) throw new Error(plan.error.message);
  console.log(planText(plan.value));
};

/** `--verify <file>`: hostname to state hash. */
const verifyFile = (platform: CliContext["platform"], path: string): Record<string, string> => {
  const parsed = parseJson(platform.readTextFile(path));
  const valid =
    !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && Object.values(parsed).every((v) => typeof v === "string");
  if (!valid) throw new Error(`--verify: ${path} is not an object of device names to state hashes.`);
  return parsed as Record<string, string>;
};

const provisionWith =
  ({ platform, timing }: CliContext) =>
  async ([configPath]: string[], options: Parameters<CommandSpec["action"]>[1]): Promise<RunResult> => {
    const loaded = await loadConfigOrThrow({ path: configPath, platform });
    // Refused before any device is touched: it would lock this app out.
    const lockout = loaded.intent && (await lockoutReason(loaded.intent, platform));
    if (lockout) throw new Error(lockout);
    // Each device is found where it is (src/locate.ts), its identity
    // checked, before anything is applied to it: always for an intent file
    // (its own facts beside it), from the UI or not. A low-level config's
    // addresses are the user's own, used as written.
    const factsFor = options.factsFor ?? (loaded.intent ? configPath : undefined);
    const { plan, hostKeys } = factsFor
      ? await locatedOrRefused(loaded.plan, factsFor, platform)
      : { plan: loaded.plan, hostKeys: {} };
    // Each device's facts as the run reads them: an applied run stamps what
    // it left there (src/applyDiff.ts stampApplied), for the next one's
    // "app update" or "changed on the device".
    const schemas = new Map<string, DeviceSchema>();
    // Appended a line at a time, from empty: read by the UI while the run goes.
    if (options.events) platform.writeTextFile(options.events as string, "");
    const report = options.events
      ? (event: ApplyEvent) => platform.appendTextFile(options.events as string, `${JSON.stringify(event)}\n`)
      : undefined;
    if (options.upgrade) {
      if (!loaded.intent || !factsFor) throw new Error("--upgrade needs an intent file: its devices' facts say what each runs.");
      const upgraded = await upgradeFirst({
        intentPath: factsFor,
        intent: loaded.intent,
        plan,
        only: chosenDevices(options.upgrade as string),
        runId: (options.runId as string | undefined) ?? Date.now().toString(36),
        platform,
        report: (device, firmware) => report?.({ at: Date.now(), device, firmware }),
        log: (line) => console.log(line),
        acceptNewSeries: !!options.acceptNewSeries,
        acceptDowngrade: !!options.acceptDowngrade,
      });
      if (!upgraded.ok) {
        report?.({ at: Date.now(), outcome: "failed" });
        return err({ ...upgraded.error, end: "failed" as const });
      }
      const itself = upgraded.value.flashingItself;
      if (itself) {
        // sysupgrade ends this process; the next start finishes the upgrade (src/firmware/self.ts).
        console.log(`${itself} is flashing itself: once back on its new release, it applies the saved settings.`);
        await platform.sleep(selfFlashLimitMs);
        forgetUpgrading(platform, factsFor);
        report?.({ at: Date.now(), outcome: "failed" });
        return err({ kind: "failed", message: `${itself} did not begin flashing itself: nothing changed there.`, end: "failed" as const });
      }
    }
    const result = await provisionConfig({
      plan,
      hostKeys,
      report,
      ...(factsFor
        ? {
            onDeviceSchema: (hostname: string, schema: DeviceSchema) => {
              schemas.set(hostname, schema);
              writeFacts(platform, factsFor, { hostname, readAt: Date.now(), schema });
            },
          }
        : {}),
      confirm: options.confirm,
      confirmTimeoutSeconds: options.confirmTimeout,
      rollbackMode: options.rollback,
      ...(options.verify ? { verify: verifyFile(platform, options.verify as string) } : {}),
      identityPath: options.identity,
      platform,
      timing,
    });
    const applied = result.ok || result.error.end === "applied-with-problems";
    if (applied && factsFor && loaded.intent) stampApplied({ plan, schemas, intentPath: factsFor, files: platform });
    return result;
  };
