// `provision`: apply a config (an intent file, or a low-level one) to its
// devices, as one change with commit-confirm (src/apply/provisionNetwork.ts);
// with --upgrade, their firmware first (src/firmware/run.ts).
import { ApplyEvent, Reporter } from "../applyEvents";
import { CommandSpec } from "../args";
import { writeFacts } from "../deviceFacts";
import { readApplyPlan, stampApplied } from "../applyDiff";
import { planText } from "../applyPlanText";
import { parseJson } from "../utils";
import { DeviceSchema } from "../deviceSchema";
import { loadConfigOrThrow } from "../loadConfig";
import { lockoutReason } from "../loginAccess";
import { provisionConfig } from "../apply/provisionConfig";
import { appliedWithProblemsExit, partialExit, RunFailure, RunResult } from "../apply/outcome";
import { applyRunning, beginRun, jobEnding } from "../apply/job";
import { isIntent } from "../intent/compile";
import { parseConfigJson } from "../parseJson";
import { chosenDevices, planAfterUpgrade, upgradeFirst } from "../firmware/run";
import { forgetUpgrading, selfFlashLimitMs } from "../firmware/self";
import { err, ok, Result } from "../result";
import { upgradePath } from "../firmware/upgradeScript";
import type { Plan } from "../plan/types";
import { problem, Problem } from "../problem";
import { CliContext, CommandFailed, locatedOrRefused } from "./context";

const runIdPattern = /^[A-Za-z0-9-]{1,64}$/;

/** The exit status for how a run ended: 0 applied, 3 applied with a problem after, 4 kept by some devices only, 1 anything else. */
const exitCodeOf = (result: RunResult) =>
  result.ok
    ? 0
    : result.error.end === "applied-with-problems"
      ? appliedWithProblemsExit
      : result.error.end === "partial"
        ? partialExit
        : 1;

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
        description: "run as the web UI's apply job (src/apply/job.ts): say how it ended in <dir>; needs --run-id",
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
      // It names files on the devices, in their shell: letters, digits and dashes only.
      if (options.runId && !runIdPattern.test(options.runId as string)) throw new Error("--run-id: letters, digits and dashes only.");
      // An intent's apply from the command line is kept as the UI's job is.
      const own = options.job ? undefined : await commandLineRun(platform, configPath);
      // How it ends is kept, however it ends, short of being killed outright.
      const end = own
        ? jobEnding(platform, own.paths.dir, own.runId)
        : options.job
          ? jobEnding(platform, options.job as string, options.runId as string)
          : undefined;
      if (end) platform.onStop((signal) => end({ signal }));
      let exitCode = 1;
      try {
        const result = own
          ? await provision([own.paths.snapshot], { ...options, factsFor: configPath, runId: own.runId }, [own.paths.events])
          : await provision([configPath], options);
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

/**
 * `provision <intent>` from the command line: run as the UI's job is
 * (src/apply/job.ts), holding the same lock, on a snapshot it makes live once
 * applied, so the UI, the collector and Status actions see it, and Undo and
 * the change plan go by what it applied. A low-level file has none of that.
 */
const commandLineRun = async (platform: CliContext["platform"], configPath: string) => {
  const json = (() => {
    try {
      return parseConfigJson(platform.readTextFile(configPath), configPath);
    } catch {
      // Said by the load, as for any config.
      return undefined;
    }
  })();
  if (!isIntent(json)) return undefined;
  const begun = await beginRun({ intentPath: configPath, files: platform, now: Date.now });
  if (!begun.ok) throw new Error(begun.error.message);
  return begun.value;
};

/** `--plan`: the change plan (src/applyPlan.ts), in words. */
const printPlan = async (platform: CliContext["platform"], configPath: string) => {
  // Not while an apply runs: it would log in to devices mid-change.
  if (await applyRunning({ intentPath: configPath, files: platform })) throw new Error("Settings are being applied: plan again once that has finished.");
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
  async (
    [configPath]: string[],
    options: Parameters<CommandSpec["action"]>[1],
    /** Where else its events go: a run kept as a job's, where the UI reads them. */
    alsoEvents: string[] = []
  ): Promise<RunResult> => {
    const loaded = await loadConfigOrThrow({ path: configPath, platform });
    // Refused before any device is touched: it would lock this app out.
    const lockout = loaded.intent && (await lockoutReason(loaded.intent, platform));
    if (lockout) throw new Error(lockout);
    // Each device is found where it is (src/locate.ts), its identity
    // checked, before anything is applied to it: always for an intent file
    // (its own facts beside it), from the UI or not. A low-level config's
    // addresses are the user's own, used as written.
    const factsFor = options.factsFor ?? (loaded.intent ? configPath : undefined);
    const locate = (plan: Plan): Promise<Located> => (factsFor ? locatedOrRefused(plan, factsFor, platform) : Promise.resolve({ plan, hostKeys: {}, alsoAt: {} }));
    const located = await locate(loaded.plan);
    // Each device's facts as the run reads them: an applied run stamps what
    // it left there (src/applyDiff.ts stampApplied), for the next one's
    // "app update" or "changed on the device".
    const schemas = new Map<string, DeviceSchema>();
    // Appended a line at a time, from empty: read by the UI while the run goes.
    const eventFiles = [...(options.events ? [options.events as string] : []), ...alsoEvents];
    eventFiles.forEach((file) => platform.writeTextFile(file, ""));
    const report = eventFiles.length
      ? (event: ApplyEvent) => eventFiles.forEach((file) => platform.appendTextFile(file, `${JSON.stringify(event)}\n`))
      : undefined;
    const upgrading = options.upgrade
      ? await upgradeThen({ loaded, located, factsFor, options, platform, report, locate })
      : ok({ ...located, stopped: undefined });
    if (!upgrading.ok) {
      report?.({ at: Date.now(), outcome: "failed" });
      return upgrading;
    }
    const { plan, hostKeys, alsoAt, stopped } = upgrading.value;
    const result = await provisionConfig({
      plan,
      hostKeys,
      alsoAt,
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
    // What each device was left holding: every device's, or (partial) the ones that kept the change.
    const stamped = applied ? plan : !result.ok && result.error.kept ? { ...plan, devices: plan.devices.filter((d) => result.error.kept!.includes(d.hostname)) } : undefined;
    if (stamped && factsFor && loaded.intent) stampApplied({ plan: stamped, schemas, intentPath: factsFor, files: platform });
    if (!stopped) return result;
    // The upgrade stopped partway, so the settings went at most to the devices
    // it upgraded: the run is partial (not taken as live) where any kept them.
    const devices = plan.devices.map((d) => d.hostname).join(", ");
    const ending = (end: RunFailure["end"], after: string, kept?: string[]) => {
      report?.({ at: Date.now(), outcome: end, ...(kept ? { kept } : {}) });
      return err({ kind: "failed" as const, message: `${stopped.message} ${after}`, end, ...(kept ? { kept } : {}) });
    };
    if (result.ok || result.error.end === "applied-with-problems") {
      return ending("partial", `The saved settings were applied to ${devices}.`, plan.devices.map((d) => d.hostname));
    }
    const { end, kept, message } = result.error;
    return ending(kept ? "partial" : end, `Applying the saved settings to ${devices} failed too: ${message}`, kept);
  };

/** A plan with its devices found where they are, and the host keys they were found by (cli/context.ts locatedOrRefused). */
type Located = { plan: Plan; hostKeys: Record<string, { type: string; key: string }>; alsoAt: Record<string, string[]> };

/**
 * `--upgrade`: the firmware first (src/firmware/run.ts), then what the apply
 * after is given: every device, found again where it is now (one back on
 * first-boot settings asks DHCP for its address). When the upgrade stopped
 * partway, only the devices it upgraded: one that kept only its SSH keys is
 * on first-boot settings until they are applied.
 */
const upgradeThen = async ({
  loaded,
  located,
  factsFor,
  options,
  platform,
  report,
  locate,
}: {
  loaded: Awaited<ReturnType<typeof loadConfigOrThrow>>;
  located: Located;
  factsFor: string | undefined;
  options: Parameters<CommandSpec["action"]>[1];
  platform: CliContext["platform"];
  report: Reporter | undefined;
  locate: (plan: Plan) => Promise<Located>;
}): Promise<Result<Located & { stopped?: Problem }, RunFailure>> => {
  if (!loaded.intent || !factsFor) throw new Error("--upgrade needs an intent file: its devices' facts say what each runs.");
  const runId = (options.runId as string | undefined) ?? Date.now().toString(36);
  const upgraded = await upgradeFirst({
    intentPath: factsFor,
    intent: loaded.intent,
    plan: located.plan,
    only: chosenDevices(options.upgrade as string),
    runId,
    platform,
    report: (device, firmware) => report?.({ at: Date.now(), device, firmware }),
    log: (line) => console.log(line),
    acceptNewSeries: !!options.acceptNewSeries,
    acceptDowngrade: !!options.acceptDowngrade,
  });
  if (!upgraded.ok) return err({ ...upgraded.error, end: "failed" as const });
  const { upgraded: done, flashingItself } = upgraded.value;
  if (flashingItself) {
    // sysupgrade ends this process; the next start finishes the upgrade (src/firmware/self.ts).
    console.log(`${flashingItself} is flashing itself: once back on its new release, it applies the saved settings.`);
    await platform.sleep(selfFlashLimitMs);
    // Still here: sysupgrade never began. Nothing is left for a start to act on.
    forgetUpgrading(platform, factsFor);
    await platform.run(["sh", upgradePath(runId), "clean"]).catch(() => undefined);
  }
  // Stopped there too: those upgraded before it still get the saved settings.
  const stopped = flashingItself ? problem("failed", `${flashingItself} did not begin flashing itself: nothing changed there.`) : upgraded.value.stopped;
  const after = planAfterUpgrade(loaded.plan, { upgraded: done, stopped });
  if (!after) return err({ kind: "failed", message: stopped?.message ?? "Nothing was upgraded.", end: "failed" as const });
  return ok({ ...(done.length ? await locate(after) : located), ...(stopped ? { stopped } : {}) });
};
