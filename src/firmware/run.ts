// `provision --upgrade <devices>`: the upgrade before the apply. It plans
// from the saved settings, the stored facts and OpenWrt's releases
// (upgradePlan.ts), refuses before anything is touched when a device cannot
// get an image, has every image built on ASU, then upgrades each device in
// turn (upgrade.ts), each over a session found as an apply finds it.
import { readFacts } from "../deviceFacts";
import type { Intent } from "../intent/schema";
import { provisionableDevices } from "../apply/provisionConfig";
import { Platform, Session } from "../platform";
import { fail, Problem, problem } from "../problem";
import type { Plan } from "../plan/types";
import { readEach } from "../readEach";
import { err, ok, Result } from "../result";
import { FirmwareStep } from "../applyEvents";
import { readReleases } from "./releases";
import { requestImages, upgradeEach, UpgradeDeps } from "./upgrade";
import { upgradePlan } from "./upgradePlan";
import { noteUpgrading } from "./self";
import { dirname } from "../posixPath";

/** `--upgrade`'s value: every device that can update, or some by name. */
export const chosenDevices = (value: string) => (value === "all" ? undefined : value.split(",").map((d) => d.trim()).filter(Boolean));

/** `work` over a session on a device, found as an apply finds it (readEach). */
const onDeviceOf =
  (intentPath: string, plan: Plan, platform: Platform): UpgradeDeps["onDevice"] =>
  async <T,>(device: string, timeoutMs: number, work: (session: Session) => Promise<T>): Promise<Result<T, Problem>> => {
    const found = provisionableDevices(plan).ready.find((d) => d.hostname === device);
    if (!found) return fail("not-found", `${device} is not in the settings.`);
    const [result] = await readEach({
      intentPath,
      platform,
      devices: [found],
      facts: readFacts(platform, intentPath, [device]),
      timeoutMs,
      read: (located) => work(located.session),
    });
    return result.ok ? ok(result.value) : err(result.error);
  };

export const upgradeFirst = async ({
  intentPath,
  intent,
  plan,
  only,
  runId,
  platform,
  report,
  log,
  acceptNewSeries = false,
  acceptDowngrade = false,
}: {
  /** Where the facts and releases are kept: the intent the job runs for. */
  intentPath: string;
  intent: Intent;
  plan: Plan;
  only?: string[];
  runId: string;
  platform: Platform;
  report: (device: string, step: FirmwareStep) => void;
  log: (line: string) => void;
  /** A move into a series this app has not been checked against, acknowledged. */
  acceptNewSeries?: boolean;
  /** A move back to an older release, acknowledged. */
  acceptDowngrade?: boolean;
}): Promise<Result<{ upgraded: string[]; flashingItself?: string }, Problem>> => {
  const facts = Object.fromEntries(
    Object.entries(readFacts(platform, intentPath, intent.hardware.map((d) => d.name))).map(([name, f]) => [name, f?.schema])
  );
  const { releases, error } = await readReleases({ intentPath, platform });
  if (!releases) return fail("unreachable", error ?? "OpenWrt's releases could not be read.");
  const unknown = (only ?? []).filter((d) => !intent.hardware.some((h) => h.name === d));
  if (unknown.length) return fail("invalid", `Not in Hardware: ${unknown.join(", ")}.`);
  const onDevice = onDeviceOf(intentPath, plan, platform);
  // The device this app runs on, if it is one of them: a session to it is local.
  const isHost = async (name: string) => {
    const local = await onDevice(name, 30_000, async (session) => !!session.local);
    return local.ok && local.value;
  };
  const host = (await Promise.all(intent.hardware.map(async ({ name }) => ((await isHost(name)) ? name : undefined)))).find(Boolean);
  const upgrade = upgradePlan({ intent, plan, facts, releases, only, sha256: platform.sha256, host });
  if (upgrade.newSeries.length && !acceptNewSeries) {
    return fail(
      "conflict",
      `Nothing was flashed: OpenWrt ${upgrade.newSeries.join(", ")} is a new series, not yet checked by this app. ` +
        "The settings would be carried over unchecked: acknowledge that to upgrade (--accept-new-series)."
    );
  }
  if (upgrade.downgrades.length && !acceptDowngrade) {
    return fail(
      "conflict",
      `Nothing was flashed: ${upgrade.downgrades.map((s) => `${s.device} would go back from ${s.from} to ${s.to}`).join("; ")}. ` +
        "Acknowledge the downgrade to go ahead (--accept-downgrade)."
    );
  }
  if (upgrade.unbuildable.length) {
    return fail("conflict", `Nothing was flashed: ${upgrade.unbuildable.map((u) => `${u.device}: ${u.why}`).join(" ")}`);
  }
  const passed = (only ?? []).filter((d) => !upgrade.steps.some((s) => s.device === d));
  passed.forEach((d) => log(`${d}: ${upgrade.staying.find((s) => s.device === d)?.why ?? "not upgraded"}`));
  if (!upgrade.steps.length) {
    log("No device to upgrade.");
    return ok({ upgraded: [] });
  }
  upgrade.steps.forEach((s) => report(s.device, "building"));
  log(`Building ${upgrade.images.length} image${upgrade.images.length === 1 ? "" : "s"} on OpenWrt's build server…`);
  const images = await requestImages(upgrade.images, platform);
  if (!images.ok) {
    upgrade.steps.forEach((s) => report(s.device, "failed"));
    return images;
  }
  const run = await upgradeEach({
    steps: upgrade.steps,
    images: images.value,
    runId,
    deps: {
      onDevice,
      sleep: platform.sleep,
      now: Date.now,
      report,
      log,
      self: {
        dir: dirname(intentPath),
        note: (step) => noteUpgrading(platform, intentPath, { to: step.to, at: Date.now() }),
      },
    },
  });
  if (run.problem) return err(problem(run.problem.kind, run.problem.message));
  return ok({ upgraded: run.upgraded, ...(run.flashingItself ? { flashingItself: run.flashingItself } : {}) });
};
