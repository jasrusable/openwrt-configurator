// The router this app runs on, upgrading itself: sysupgrade ends every
// process, the run's included, so the run cannot see it through. Before it
// flashes, it keeps a note of what it is upgrading to beside the intent
// (kept through the upgrade with the rest of the app's directory, upgrade
// script's keep-self); at the first start after (the status collector's
// service), the note is read once: on the new release, the saved settings
// are applied as the run would have; on any other, that is kept to be said.
import { z } from "zod";
import { Platform } from "../platform";
import { read, remove, stateLayout, StoreKey, tryWrite } from "../store";
import { startProvision } from "../server/provisionJob";

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
const runningRelease = async (platform: Pick<Platform, "run">) => {
  const { stdout, code } = await platform.run(["ubus", "call", "system", "board"]);
  try {
    const version = code === 0 ? (JSON.parse(stdout) as { release?: { version?: unknown } }).release?.version : undefined;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
};

/**
 * At the first start after the router flashed itself: the note read once and
 * dropped; on the new release, the apply the run would have made is started.
 */
export const finishSelfUpgrade = async ({
  intentPath,
  platform,
  now = Date.now,
}: {
  intentPath: string;
  platform: Parameters<typeof startProvision>[0]["files"] & Pick<Platform, "run">;
  now?: () => number;
}): Promise<SelfUpgradeResult | undefined> => {
  const pending = read(platform, upgradingKey(intentPath));
  if (!pending) return undefined;
  remove(platform, upgradingKey(intentPath));
  const running = await runningRelease(platform);
  const result: SelfUpgradeResult =
    running !== pending.to
      ? { ...pending, ok: false, message: `The router came back on ${running ?? "a release it did not say"}, not ${pending.to}: its settings are as they were.` }
      : await (async () => {
          const started = await startProvision({ intentPath, files: platform, now });
          return started.started
            ? { ...pending, ok: true, message: `The router is on ${pending.to}: applying the saved settings.` }
            : { ...pending, ok: true, message: `The router is on ${pending.to}. Applying did not start (${started.reason}): apply again.` };
        })();
  tryWrite(platform, selfUpgradeResultKey(intentPath), result);
  return result;
};
