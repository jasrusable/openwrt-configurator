// `provision --upgrade <devices>`: the upgrade before the apply. It plans
// from the saved settings, the stored facts and OpenWrt's releases
// (upgradePlan.ts) and refuses, before any device is touched, what the plan
// alone can tell (an acknowledgement missing, a device with no image). Then
// it reads each device that would move, once: whether this app runs on it,
// and whether this machine is on its Wi-Fi; plans again with that, refusing
// what would strand one; has every image built on ASU; and upgrades each
// device in turn (upgrade.ts), each over a session found as an apply finds it.
import { readFacts } from "../deviceFacts";
import type { Intent } from "../intent/schema";
import { provisionableDevices } from "../apply/provisionConfig";
import { ownMacs } from "../apply/gateway";
import { wifiStations } from "../deviceProbes";
import { appPublicKey } from "../loginAccess";
import { Platform, Session } from "../platform";
import { fail, Problem, problem } from "../problem";
import type { Plan } from "../plan/types";
import { readEach } from "../readEach";
import { err, ok, Result } from "../result";
import { FirmwareStep } from "../applyEvents";
import { readReleases } from "./releases";
import { requestImages, upgradeEach, UpgradeDeps } from "./upgrade";
import { UpgradePlan, upgradePlan, UpgradeStep } from "./upgradePlan";
import { firmwareRows, FirmwareRow } from "./target";
import { forgetUpgrading, noteUpgrading } from "./self";
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

/** The devices of `only` (unset, every one) whose release is not known: they follow a series whose releases were not read. */
const releaseUnknown = (rows: FirmwareRow[], only?: string[]) =>
  rows.filter((r) => (!only || only.includes(r.device)) && r.state === "unknown").map((r) => r.device);

/** Its Wi-Fi clients: a read that did not answer is a device not reached, never one with none (it could strand this machine). */
export const stationsOf = async (session: Session) => {
  const answer = await session.execCommand(wifiStations.command);
  if (answer.timedOut || answer.code === null) throw new Error("its Wi-Fi clients could not be read");
  return wifiStations.parse(answer);
};

/**
 * Where this app keeps its settings and state, as the device it runs on keeps
 * it through its own upgrade (keep.d): absolute, as a relative one would name
 * nothing there.
 */
const absoluteDir = async (platform: Pick<Platform, "run">, dir: string): Promise<string | undefined> => {
  if (dir.startsWith("/")) return dir;
  const pwd = await platform.run(["sh", "-c", 'cd -- "$1" && pwd', "sh", dir]).catch(() => undefined);
  const absolute = pwd?.stdout.trim();
  return pwd?.code === 0 && absolute?.startsWith("/") ? absolute : undefined;
};

/** Why a plan cannot go ahead as acknowledged, if it cannot: nothing has been flashed. */
const refusalOf = (
  upgrade: UpgradePlan,
  { acceptNewSeries, acceptDowngrade }: { acceptNewSeries: boolean; acceptDowngrade: boolean }
): Problem | undefined => {
  if (upgrade.newSeries.length && !acceptNewSeries) {
    return problem(
      "conflict",
      `Nothing was flashed: OpenWrt ${upgrade.newSeries.join(", ")} is a new series, not yet checked by this app. ` +
        "The settings would be carried over unchecked: acknowledge that to upgrade (--accept-new-series)."
    );
  }
  if (upgrade.downgrades.length && !acceptDowngrade) {
    return problem(
      "conflict",
      `Nothing was flashed: ${upgrade.downgrades.map((s) => `${s.device} would go back from ${s.from} to ${s.to}`).join("; ")}. ` +
        "Acknowledge the downgrade to go ahead (--accept-downgrade)."
    );
  }
  if (!upgrade.refused.length) return undefined;
  // One reason said once, with every device it holds back.
  const reasons = [...new Set(upgrade.refused.map((r) => r.why))].map(
    (why) => `${upgrade.refused.filter((r) => r.why === why).map((r) => r.device).join(", ")}: ${why}`
  );
  return problem("conflict", `Nothing was flashed. ${reasons.join(" ")}`);
};

/** How an upgrade went: the devices upgraded, the one this app runs on if it is flashing itself, and what stopped it partway. */
export type UpgradeRun = { upgraded: string[]; flashingItself?: string; stopped?: Problem };

/**
 * What the apply after an upgrade is given: every device; when the upgrade
 * stopped partway, only those it upgraded (one that kept only its SSH keys is
 * on first-boot settings until then), and with none, nothing to apply.
 */
export const planAfterUpgrade = (plan: Plan, { upgraded, stopped }: Pick<UpgradeRun, "upgraded" | "stopped">): Plan | undefined =>
  !stopped ? plan : upgraded.length ? { ...plan, devices: plan.devices.filter((d) => upgraded.includes(d.hostname)) } : undefined;

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
}): Promise<Result<UpgradeRun, Problem>> => {
  const facts = Object.fromEntries(
    Object.entries(readFacts(platform, intentPath, intent.hardware.map((d) => d.name))).map(([name, f]) => [name, f?.schema])
  );
  const unknown = (only ?? []).filter((d) => !intent.hardware.some((h) => h.name === d));
  if (unknown.length) return fail("invalid", `Not in Hardware: ${unknown.join(", ")}.`);
  // Needed only for a device that follows a series: a release named for it is known without.
  const { releases, error } = await readReleases({ intentPath, platform });
  const blind = releases ? [] : releaseUnknown(firmwareRows({ intent, facts }), only);
  if (blind.length) return fail("unreachable", `${error ?? "OpenWrt's releases could not be read"}: which release ${blind.join(", ")} should move to is not known.`);
  const acks = { acceptNewSeries, acceptDowngrade };
  const appKey = await appPublicKey(intent, platform);
  const planWith = (seen: { host?: string; viaWifi?: string[] }) =>
    upgradePlan({ intent, plan, facts, releases, only, sha256: platform.sha256, appKey, ...seen });
  // What the plan alone can refuse, refused before any device is touched.
  const draft = planWith({});
  const refused = refusalOf(draft, acks);
  if (refused) return err(refused);
  const passed = (only ?? []).filter((d) => !draft.steps.some((s) => s.device === d));
  passed.forEach((d) => log(`${d}: ${draft.staying.find((s) => s.device === d)?.why ?? "not upgraded"}`));
  if (!draft.steps.length) {
    log("No device to upgrade.");
    return ok({ upgraded: [] });
  }
  // Each device that would move, read once: whether this app runs on it (its
  // session is local), and whether this machine is one of its Wi-Fi clients.
  // One that cannot be read now could not be upgraded either.
  const onDevice = onDeviceOf(intentPath, plan, platform);
  const mine = await ownMacs(platform);
  const seen = await Promise.all(
    draft.steps.map(async ({ device }) => ({
      device,
      read: await onDevice(device, 30_000, async (session) => ({
        local: !!session.local,
        stations: session.local ? [] : await stationsOf(session),
      })),
    }))
  );
  const unreached = seen.flatMap(({ device, read }) => (read.ok ? [] : [`${device} could not be reached (${read.error.message})`]));
  if (unreached.length) return fail("unreachable", `Nothing was flashed: ${unreached.join("; ")}.`);
  const reads = seen.flatMap(({ device, read }) => (read.ok ? [{ device, ...read.value }] : []));
  const upgrade = planWith({
    host: reads.find((r) => r.local)?.device,
    viaWifi: reads.filter((r) => r.stations.some((mac) => mine.includes(mac))).map((r) => r.device),
  });
  const stranding = refusalOf(upgrade, acks);
  if (stranding) return err(stranding);
  // This app's own device: kept through its flash from where its settings are.
  const flashesSelf = upgrade.steps.some((step) => step.host);
  const appDir = flashesSelf ? await absoluteDir(platform, dirname(intentPath)) : undefined;
  if (flashesSelf && !appDir) return fail("internal", `Nothing was flashed: where ${intentPath} is could not be told, to keep it through the upgrade.`);
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
      ...(appDir
        ? {
            self: {
              dir: appDir,
              note: (step: UpgradeStep) => noteUpgrading(platform, intentPath, { to: step.to, at: Date.now() }),
              forget: () => forgetUpgrading(platform, intentPath),
            },
          }
        : {}),
    },
  });
  return ok({
    upgraded: run.upgraded,
    ...(run.flashingItself ? { flashingItself: run.flashingItself } : {}),
    ...(run.problem ? { stopped: problem(run.problem.kind, run.problem.message) } : {}),
  });
};
