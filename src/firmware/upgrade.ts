// A firmware upgrade, run before the apply that follows it (provision
// --upgrade): every image requested from ASU first, so a build that fails
// says so before anything is flashed; then one device at a time, in the
// plan's order (the router last), each fetching its own image from ASU into
// its RAM (never through this machine: on a router there is no flash to keep
// one on), checking it, flashing with its settings kept, and answering again
// on the new release before the next is touched. The first failure stops it,
// the device's copy removed; devices already upgraded keep their settings
// and work on, and the apply after brings them all up to date.
import { asuImageUrl, pickSysupgradeImage, pollBuild, requestBuild } from "../buildImage";
import { FirmwareStep } from "../applyEvents";
import { ExecResult, Platform, Session } from "../platform";
import { fail, Problem } from "../problem";
import { attempt, err, messageOf, ok, Result } from "../result";
import { ImagePlan } from "./builds";
import { findProfile } from "./profiles";
import { UpgradeStep } from "./upgradePlan";
import { upgradePath, upgradeScript } from "./upgradeScript";

/** A built image, where a device downloads it from. */
export type Requested = { url: string; sha256: string; sizeKb: number };

const sha256Pattern = /^[0-9a-f]{64}$/;
const urlPattern = /^https:\/\/sysupgrade\.openwrt\.org\/store\/[A-Za-z0-9._/-]+$/;

/** One image built on ASU (nothing downloaded): where it is, its sha256 and size. */
export const requestImage = async (image: ImagePlan, platform: Pick<Platform, "http" | "sleep">): Promise<Requested> => {
  const profile = await findProfile({ version: image.version, target: image.target, board: image.board, platform });
  const { requestHash } = await requestBuild({
    req: { version: image.version, target: image.target, profile, packages: image.packages, defaults: image.defaults },
    platform,
  });
  const built = await pollBuild({ requestHash, platform });
  const sysupgrade = pickSysupgradeImage(built);
  const requested = {
    url: asuImageUrl(built.bin_dir, sysupgrade.name),
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
  return ok(Object.fromEntries(images.map((image, i) => [image.hash, (each[i] as { value: Requested }).value])));
};

/** The verb's answer: its word on stdout, else its words. */
const answered = (result: ExecResult, word: string): Result<void, string> =>
  result.code === 0 && result.stdout.includes(word)
    ? ok(undefined)
    : err(result.timedOut ? "it stopped answering" : result.stderr.trim().replace(/^onc-upgrade: /, "") || `it said ${result.code}`);

/** The device this app runs on (a local session): kept through its own upgrade, and noted to finish at its next start (self.ts). */
export type SelfKeep = { dir: string; note: (step: UpgradeStep) => void };

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

/** One device's image into its RAM, checked, then flashed; its copy removed on any failure. */
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
  const itself = !!session.local;
  if (itself && !self) return err("this app runs on it, and was not told how to keep itself through the upgrade");
  const script = upgradePath(runId);
  const verb = (name: string, options: { stdin?: string; timeoutMs?: number } = {}) =>
    session.execCommand(`sh ${script} ${name}`, options);
  const written = await session.execCommand(`cat > ${script}`, { stdin: upgradeScript });
  if (written.code !== 0) return err("the upgrade script could not be written to /tmp");
  const steps: [FirmwareStep | undefined, () => Promise<ExecResult>, string][] = [
    [undefined, () => verb(`room ${image.sizeKb}`), "ONC_ROOM"],
    ["downloading", () => verb("fetch", { stdin: `${image.url}\n${image.sha256}\n`, timeoutMs: 10 * 60_000 }), "ONC_FETCHED"],
    ["checking", () => verb("check"), "ONC_CHECKED"],
    ...(itself
      ? [
          [
            undefined,
            async () => {
              const kept = await verb("keep-self", { stdin: `${self!.dir}\n`, timeoutMs: 5 * 60_000 });
              if (kept.code === 0) self!.note(step);
              return kept;
            },
            "ONC_KEPT",
          ] as [FirmwareStep | undefined, () => Promise<ExecResult>, string],
        ]
      : []),
    ["flashing", () => verb(step.keep === "keys" ? "flash-keys" : "flash"), "ONC_FLASHING"],
  ];
  for (const [shown, run, word] of steps) {
    if (shown) report(step.device, shown);
    const done = answered(await run(), word);
    if (!done.ok) {
      // Its copy of the image goes (each verb removes it on failure; this also takes the script).
      await session.execCommand(`sh ${script} clean`).catch(() => undefined);
      return err(word === "ONC_ROOM" ? `not enough RAM: ${done.error}` : done.error);
    }
  }
  return ok({ self: itself });
};

/** The release a device says it runs (ubus system board), undefined when it does not say. */
const releaseOf = async (session: Session) => {
  const { stdout, code } = await session.execCommand("ubus call system board");
  try {
    const version = code === 0 ? (JSON.parse(stdout) as { release?: { version?: unknown } }).release?.version : undefined;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
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
  const upgraded: string[] = [];
  for (const step of steps) {
    const stopped = (why: string) => {
      deps.report(step.device, "failed");
      const before = upgraded.length ? ` ${upgraded.join(", ")} ${upgraded.length === 1 ? "was" : "were"} upgraded, settings kept.` : "";
      return { upgraded, problem: { kind: "failed" as const, message: `${step.device}: ${why}.${before} Nothing after it was touched.` } };
    };
    deps.log(`${step.device}: ${step.from} → ${step.to}`);
    const flashed = await deps.onDevice(step.device, flashLimitMs, (session) =>
      flashOne({ step, image: images[step.image], session, runId, report: deps.report, self: deps.self })
    );
    if (!flashed.ok) return stopped(`could not be reached (${flashed.error.message})`);
    if (!flashed.value.ok) return stopped(flashed.value.error);
    deps.report(step.device, "rebooting");
    // This app runs on it: the run ends with it, and its next start finishes the upgrade (self.ts).
    if (flashed.value.value.self) return { upgraded, flashingItself: step.device };
    const back = await backOn(step.device, step.to, deps);
    if (!back.ok) return stopped(back.error);
    deps.report(step.device, "upgraded");
    deps.log(`${step.device}: on ${step.to}, settings kept`);
    upgraded.push(step.device);
  }
  return { upgraded };
};
