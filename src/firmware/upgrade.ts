// A firmware upgrade, run before the apply that follows it (provision
// --upgrade): every image requested from ASU first, so a build that fails
// says so before anything is flashed; then one device at a time, in the
// plan's order (the router last), each fetching its own image from ASU into
// its RAM (never through this machine: on a router there is no flash to keep
// one on), checking it, flashing it, and answering again on the new release
// before the next is touched. Each is checked first to run what it was
// planned from, and to be (or not be) the device this app runs on as
// planned. The first failure stops it, the device's copy removed; the saved
// settings are then applied to the devices already upgraded (cli/provision.ts).
import { asuImageUrl } from "../buildImage";
import { FirmwareStep } from "../applyEvents";
import { ExecResult, Platform, Session } from "../platform";
import { fail, Problem } from "../problem";
import { boardRelease } from "../release";
import { attempt, err, messageOf, ok, Result } from "../result";
import { buildOnAsu, ImagePlan } from "./builds";
import { UpgradeStep } from "./upgradePlan";
import { upgradePath, upgradeScript } from "./upgradeScript";
import { call, saysLine, Verb } from "../agent";
import { writeScriptCommand } from "../agent/prelude";

/** A built image, where a device downloads it from. */
export type Requested = { url: string; sha256: string; sizeKb: number };

const sha256Pattern = /^[0-9a-f]{64}$/;
const urlPattern = /^https:\/\/sysupgrade\.openwrt\.org\/store\/[A-Za-z0-9._/-]+$/;

/** One image built on ASU (nothing downloaded): where it is, its sha256 and size. */
export const requestImage = async (image: ImagePlan, platform: Pick<Platform, "http" | "sleep">): Promise<Requested> => {
  const { build, sysupgrade } = await buildOnAsu({ image, platform });
  const requested = {
    url: asuImageUrl(build.bin_dir, sysupgrade.name),
    sha256: sysupgrade.sha256,
    sizeKb: Math.ceil((sysupgrade.size ?? 0) / 1024),
  };
  // What reaches the device's shell: checked, though it is ASU's own answer.
  if (!urlPattern.test(requested.url) || !sha256Pattern.test(requested.sha256) || !sysupgrade.size) {
    throw new Error(`ASU's answer for ${image.board} is not an image this app can use.`);
  }
  return requested;
};

/** Every image at once; any that cannot be built is said, each with why, and none is flashed. */
export const requestImages = async (
  images: ImagePlan[],
  platform: Pick<Platform, "http" | "sleep">
): Promise<Result<Record<string, Requested>, Problem>> => {
  const each = await Promise.all(images.map((image) => attempt(() => requestImage(image, platform), messageOf)));
  const failed = images.flatMap((image, i) => {
    const outcome = each[i];
    return outcome.ok ? [] : [`${image.board} (${image.devices.join(", ")}), OpenWrt ${image.version}: ${outcome.error}`];
  });
  if (failed.length) return fail("failed", `Nothing was flashed: ${failed.length === 1 ? "an image" : "images"} could not be built. ${failed.join(" ")}`);
  return ok(Object.fromEntries(each.flatMap((outcome, i) => (outcome.ok ? [[images[i].hash, outcome.value] as const] : []))));
};

/** One verb of the device's script, as the agent's are called (agent/index.ts): through when it says `word` on a line of its own, else its words. */
const upgradeVerb = (
  script: string,
  name: string,
  word: string,
  options: { stdin?: string; timeoutMs?: number } = {}
): Verb<Result<void, string>> => ({
  command: `sh ${script} ${name}`,
  ...options,
  parse: (result: ExecResult) =>
    result.code === 0 && saysLine(result.stdout, word)
      ? ok(undefined)
      : err(result.stderr.trim().replace(/^onc-upgrade: /, "") || `it said ${result.code}`),
});

/**
 * The device this app runs on (a local session): kept through its own
 * upgrade, and noted to finish at its next start (self.ts); the note
 * forgotten when the flash does not go ahead.
 */
export type SelfKeep = { dir: string; note: (step: UpgradeStep) => void; forget: () => void };

export type UpgradeDeps = {
  self?: SelfKeep;
  /** `work` over a session on a device, found as an apply finds it, ended by `timeoutMs`. */
  onDevice: <T>(device: string, timeoutMs: number, work: (session: Session) => Promise<T>) => Promise<Result<T, Problem>>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  report: (device: string, step: FirmwareStep) => void;
  log: (line: string) => void;
};

/** How long a device may take to come back on its new release: writing flash is slow on some boards. */
export const rebootLimitMs = 10 * 60_000;
const pollEveryMs = 10_000;
/** A device's image fetched, checked and handed to sysupgrade: the download is most of it. */
const flashLimitMs = 15 * 60_000;

/** A step of a device's flash: its verb, shown as `shown`. */
type FlashStep = {
  shown?: FirmwareStep;
  verb: Verb<Result<void, string>>;
  /** Its failure, in words. */
  failure?: (why: string) => string;
  /** Once it went through. */
  then?: () => void;
};

/** What a device runs now, as it says. */
const releaseOf = async (session: Session) => boardRelease(await session.execCommand("ubus call system board"));

/** Why a session is not the one the step was planned for, if it is not: the device this app runs on is planned as such, and only it. */
const wrongSession = (step: UpgradeStep, session: Session, self?: SelfKeep) => {
  if (session.local && !step.host) return "this app runs on it, but the upgrade was not planned so: plan it again";
  if (!session.local && step.host) return "it was planned as the device this app runs on, but is not: plan it again";
  if (session.local && !self) return "this app runs on it, and was not told how to keep itself through the upgrade";
  return undefined;
};

/** One device's image into its RAM, checked, then flashed; its copy, and anything kept for the flash, removed on any failure. */
export const flashOne = async ({
  step,
  image,
  session,
  runId,
  report,
  self,
}: {
  step: UpgradeStep;
  image: Requested;
  session: Session;
  runId: string;
  report: UpgradeDeps["report"];
  self?: SelfKeep;
}): Promise<Result<{ self: boolean }, string>> => {
  const wrong = wrongSession(step, session, self);
  if (wrong) return err(wrong);
  // What it runs now, not what was last read: a device moved by hand since would be moved again unacknowledged.
  const running = await releaseOf(session);
  if (running !== step.from) {
    return err(`it runs ${running ?? "a release it does not say"} now, not ${step.from} as last read: read it again (Hardware) and plan again`);
  }
  const script = upgradePath(runId);
  const written = await call(session, { command: writeScriptCommand(script), stdin: upgradeScript, parse: ({ code }) => code === 0 });
  if (!(written.ok && written.value)) return err("the upgrade script could not be written to /tmp");
  const keepSelf = (keeper: SelfKeep): FlashStep => ({
    verb: upgradeVerb(script, "keep-self", "ONC_KEPT", { stdin: `${keeper.dir}\n`, timeoutMs: 5 * 60_000 }),
    then: () => keeper.note(step),
  });
  const steps: FlashStep[] = [
    { verb: upgradeVerb(script, `room ${image.sizeKb}`, "ONC_ROOM"), failure: (why) => `not enough RAM: ${why}` },
    { shown: "downloading", verb: upgradeVerb(script, "fetch", "ONC_FETCHED", { stdin: `${image.url}\n${image.sha256}\n`, timeoutMs: 10 * 60_000 }) },
    { shown: "checking", verb: upgradeVerb(script, "check", "ONC_CHECKED") },
    ...(session.local && self ? [keepSelf(self)] : []),
    { shown: "flashing", verb: upgradeVerb(script, step.keep === "keys" ? "flash-keys" : "flash", "ONC_FLASHING") },
  ];
  for (const { shown, verb, failure = (why: string) => why, then } of steps) {
    if (shown) report(step.device, shown);
    // No answer (it timed out, the link dropped) is said as such.
    const answer = await call(session, verb);
    const done = answer.ok ? answer.value : err(`it stopped answering (${answer.error.message})`);
    if (!done.ok) {
      // Its copy of the image goes, a download still running, what keep-self left, and the script.
      await session.execCommand(`sh ${script} clean`).catch(() => undefined);
      if (session.local) self?.forget();
      return err(failure(done.error));
    }
    then?.();
  }
  return ok({ self: !!session.local });
};

/** Waits for a device to answer on `version`, at most `rebootLimitMs`. */
export const backOn = async (device: string, version: string, deps: Pick<UpgradeDeps, "onDevice" | "sleep" | "now">) => {
  const until = deps.now() + rebootLimitMs;
  let seen: string | undefined;
  while (deps.now() < until) {
    await deps.sleep(pollEveryMs);
    const answer = await deps.onDevice(device, 30_000, releaseOf);
    seen = (answer.ok ? answer.value : undefined) ?? seen;
    if (answer.ok && answer.value === version) return ok(undefined);
  }
  return err(seen ? `it came back on ${seen}, not ${version}` : `it did not answer within ${rebootLimitMs / 60_000} minutes`);
};

/** What a step's flash kept, in words. */
export const keptWords = (step: Pick<UpgradeStep, "keep">) =>
  step.keep === "settings" ? "settings kept" : "only its SSH keys kept, on first-boot settings until the apply";

/**
 * Each device in turn, stopping at the first failure. What it says: the
 * devices upgraded, and the problem that stopped it, if any.
 */
export const upgradeEach = async ({
  steps,
  images,
  runId,
  deps,
}: {
  steps: UpgradeStep[];
  images: Record<string, Requested>;
  runId: string;
  deps: UpgradeDeps;
}): Promise<{ upgraded: string[]; problem?: Problem; flashingItself?: string }> => {
  const done: UpgradeStep[] = [];
  for (const step of steps) {
    const stopped = (why: string) => {
      deps.report(step.device, "failed");
      const before = done.length ? ` Upgraded before it: ${done.map((s) => `${s.device} (${keptWords(s)})`).join(", ")}.` : "";
      return {
        upgraded: done.map((s) => s.device),
        problem: { kind: "failed" as const, message: `${step.device}: ${why}.${before} Nothing after it was touched.` },
      };
    };
    deps.log(`${step.device}: ${step.from} → ${step.to}`);
    const flashed = await deps.onDevice(step.device, flashLimitMs, (session) =>
      flashOne({ step, image: images[step.image], session, runId, report: deps.report, self: deps.self })
    );
    if (!flashed.ok) return stopped(`could not be reached (${flashed.error.message})`);
    if (!flashed.value.ok) return stopped(flashed.value.error);
    deps.report(step.device, "rebooting");
    // This app runs on it: the run ends with it, and its next start finishes the upgrade (self.ts).
    if (flashed.value.value.self) return { upgraded: done.map((s) => s.device), flashingItself: step.device };
    const back = await backOn(step.device, step.to, deps);
    if (!back.ok) return stopped(back.error);
    deps.report(step.device, "upgraded");
    deps.log(`${step.device}: on ${step.to}, ${keptWords(step)}`);
    done.push(step);
  }
  return { upgraded: done.map((s) => s.device) };
};
