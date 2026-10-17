// The router this app runs on, upgrading itself: sysupgrade ends every
// process, the run's included, so the run cannot see it through. Before it
// flashes, it keeps a note of what it is upgrading to beside the intent
// (kept through the upgrade with the rest of the app's directory, upgrade
// script's keep-self); at the first start after (the status collector's
// service), the note is read once: on the new release, once the network is
// up, the settings the upgrade was started with are applied as the run would
// have (on any other release too, for the devices upgraded before it), and
// how it went kept to be said. A flash that does not go ahead forgets the note.
import { z } from "zod";
import { Platform } from "../platform";
import { read, remove, stateLayout, StoreKey, tryWrite } from "../store";
import { jobPaths, startProvision } from "../apply/job";
import { intentFileOrNothing } from "../settings";
import { boardRelease } from "../release";

export type Upgrading = { to: string; at: number };
/** How a self-upgrade ended, once its note has been read at the next start. */
export type SelfUpgradeResult = { to: string; at: number; ok: boolean; message: string };

const upgradingKey = (intentPath: string): StoreKey<Upgrading> => ({
  path: `${stateLayout(intentPath).root}/upgrading.json`,
  schema: z.object({ to: z.string(), at: z.number() }),
  format: 1,
});

export const selfUpgradeResultKey = (intentPath: string): StoreKey<SelfUpgradeResult> => ({
  path: `${stateLayout(intentPath).root}/self-upgrade.json`,
  schema: z.object({ to: z.string(), at: z.number(), ok: z.boolean(), message: z.string() }),
  format: 1,
});

/** How long a router flashing itself may take to end this run: past it, sysupgrade never began. */
export const selfFlashLimitMs = 5 * 60_000;

/** A flash that never began: its note dropped, so no start acts on it. */
export const forgetUpgrading = (files: Pick<Platform, "removeFile">, intentPath: string) => remove(files, upgradingKey(intentPath));

/** Before the router flashes itself: what it is upgrading to. */
export const noteUpgrading = (files: Parameters<typeof tryWrite>[0], intentPath: string, upgrading: Upgrading) =>
  tryWrite(files, upgradingKey(intentPath), upgrading);

/** What this device runs, from ubus. */
const runningRelease = async (platform: Pick<Platform, "run">) => boardRelease(await platform.run(["ubus", "call", "system", "board"]));

/**
 * Whether the network has come up after a start (`ubus call network.interface
 * dump`): an interface up, and none still being set up (netifd's `pending`).
 */
export const networkSettled = (dump: string) => {
  try {
    const interfaces = (JSON.parse(dump) as { interface?: { up?: unknown; pending?: unknown }[] } | null)?.interface ?? [];
    return interfaces.some((i) => i.up === true) && !interfaces.some((i) => i.pending === true);
  } catch {
    return false;
  }
};

/** How long a start waits for the network before applying anyway (a WAN that never comes up stays pending). */
export const networkWaitMs = 3 * 60_000;
const networkPollMs = 5_000;

/** Waits for the network to come up, at most until `until`: the collector starts during boot, before it has. */
const networkUp = async (platform: Pick<Platform, "run" | "sleep">, now: () => number, until: number): Promise<boolean> => {
  const dump = await platform.run(["ubus", "call", "network.interface", "dump"]).catch(() => undefined);
  if (dump?.code === 0 && networkSettled(dump.stdout)) return true;
  if (now() >= until) return false;
  await platform.sleep(networkPollMs);
  return networkUp(platform, now, until);
};

/**
 * At the first start after the router flashed itself: the note read once and
 * dropped; once the network is up, the apply the run would have made is
 * started, of the settings the upgrade was started with (the job's snapshot,
 * kept through the flash with the app's directory), never ones saved since.
 * On another release than planned, the flash did not take, but the devices
 * upgraded before it still need them.
 */
export const finishSelfUpgrade = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Parameters<typeof startProvision>[0]["files"] & Pick<Platform, "run" | "sleep">;
  now?: () => number;
}): Promise<SelfUpgradeResult | undefined> => {
  const pending = read(platform, upgradingKey(intentPath));
  if (!pending) return undefined;
  remove(platform, upgradingKey(intentPath));
  const running = await runningRelease(platform);
  const source = jobPaths(intentPath).snapshot;
  const kept = intentFileOrNothing(platform, source) !== undefined;
  // The devices it applies to are reached over the network: not before it is up.
  if (kept) await networkUp(platform, now, now() + networkWaitMs);
  const started = kept ? await startProvision({ intentPath, files: platform, now, source }) : { started: false as const, reason: "the settings it was started with were not kept" };
  const applying = started.started ? "applying the settings the upgrade was started with" : `applying did not start (${started.reason}): apply again`;
  const result: SelfUpgradeResult =
    running === pending.to
      ? { ...pending, ok: true, message: `The router is on ${pending.to}: ${applying}.` }
      : {
          ...pending,
          ok: false,
          message: `The router came back on ${running ?? "a release it did not say"}, not ${pending.to}, its own settings as they were: ${applying}, for the devices upgraded before it.`,
        };
  tryWrite(platform, selfUpgradeResultKey(intentPath), result);
  return result;
};
