// System › Firmware: what OpenWrt has out (src/firmware/releases.ts), asked
// when the tab opens if the kept answer is a day old; and an upgrade,
// started as the apply job with its firmware step first (provision
// --upgrade): one change at a time, the collector paused, the saved settings
// applied once the devices are back. Where each device stands is worked out
// in the page, from the draft and the facts (src/firmware/target.ts), and
// again here from the saved settings: what was acknowledged must be what
// moves. Nothing unreviewed goes out with it: saved changes not yet applied
// (beyond the firmware choices themselves) are refused.
import { readReleases } from "../../firmware/releases";
import { selfUpgradeResultKey } from "../../firmware/self";
import { read } from "../../store";
import { namePattern } from "../../intent/validators";
import { lockoutReason } from "../../loginAccess";
import { problem } from "../../problem";
import { intentFileOrNothing, loadSettings } from "../../settings";
import { jobPaths, startProvision } from "../../apply/job";
import { readFacts } from "../../deviceFacts";
import { acknowledgementsOf, firmwareRows, isFirmwareChoice, movingRows } from "../../firmware/target";
import { diffIntent } from "../../intent/diff";
import { Platform } from "../../platform";
import { ApiContext, json, problemResponse, Route, withBody } from "../router";
import { changedElsewhere, versionHeader } from "./intent";

const conflict = (message: string) => problemResponse(problem("conflict", message));

/** What the page acknowledged: each downgrade (device to release), each new series, and applying settings never applied. */
const acknowledgedOf = (value: unknown) => {
  const given = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const downgrades = given.downgrades && typeof given.downgrades === "object" ? (given.downgrades as Record<string, unknown>) : {};
  return {
    downgrades: Object.fromEntries(Object.entries(downgrades).filter((e): e is [string, string] => typeof e[1] === "string")),
    newSeries: Array.isArray(given.newSeries) ? given.newSeries.filter((s): s is string => typeof s === "string") : [],
    unapplied: given.unapplied === true,
  };
};

/**
 * Why the apply after an upgrade would send settings nobody reviewed, if it
 * would: saved changes not applied yet, beyond which release each device
 * runs (which compile to nothing on a device). With nothing applied from
 * here yet, the whole of them goes, acknowledged.
 */
const unappliedRefusal = (files: Pick<Platform, "readTextFile">, intentPath: string, acknowledged: boolean) => {
  const live = intentFileOrNothing(files, jobPaths(intentPath).live);
  if (live === undefined) {
    return acknowledged ? undefined : "Nothing has been applied from here yet: acknowledge that the saved settings are applied, whole, once the devices are back.";
  }
  const pending = diffIntent(live, intentFileOrNothing(files, intentPath)).filter((c) => !isFirmwareChoice(c.path));
  return pending.length
    ? `Saved changes are not applied yet (${pending.map((c) => c.label.join(" › ")).join("; ")}): apply them first, reviewed, then upgrade.`
    : undefined;
};

/** `devices`: names (each a hostname), or absent for every device that can update. */
const devicesOf = (value: unknown): string[] | "all" | null =>
  value === undefined
    ? "all"
    : Array.isArray(value) && value.length > 0 && value.every((d) => typeof d === "string" && namePattern.test(d))
      ? (value as string[])
      : null;

export const firmwareRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => [
  {
    path: "/api/firmware",
    GET: async () =>
      json(200, {
        ...(await readReleases({ intentPath, platform, now })),
        // How the router's upgrade of itself ended, once it was back (src/firmware/self.ts).
        selfUpgrade: read(platform, selfUpgradeResultKey(intentPath)),
      }),
  },
  {
    path: "/api/firmware/upgrade",
    POST: withBody(async (input, request) => {
      const devices = devicesOf(input.devices);
      if (devices === null) return problemResponse(problem("invalid", "devices is not a list of device names."));
      if (changedElsewhere(platform, intentPath, request)) {
        return conflict("The settings were changed elsewhere since this page read them: reload, check, then upgrade.");
      }
      const saved = await loadSettings(intentPath, platform);
      if (!saved.ok) return problemResponse(saved.error);
      // The apply after the upgrade would lock this app out: said now, not after the flash.
      const lockout = await lockoutReason(saved.value.intent, platform);
      if (lockout) return conflict(lockout);
      const acknowledged = acknowledgedOf(input.acknowledged);
      const unapplied = unappliedRefusal(platform, intentPath, acknowledged.unapplied);
      if (unapplied) return conflict(unapplied);
      // What it moves, worked out as the page did: acknowledged for exactly these devices, releases and series.
      const { intent } = saved.value;
      const facts = readFacts(platform, intentPath, intent.hardware.map((d) => d.name));
      const { releases } = await readReleases({ intentPath, platform, now });
      const rows = firmwareRows({ intent, facts: Object.fromEntries(Object.entries(facts).map(([name, f]) => [name, f?.schema])), releases });
      const needed = acknowledgementsOf(movingRows(rows, devices === "all" ? undefined : devices));
      const missing = [
        ...Object.entries(needed.downgrades).filter(([device, to]) => acknowledged.downgrades[device] !== to),
        ...needed.newSeries.filter((series) => !acknowledged.newSeries.includes(series)),
      ];
      if (missing.length) return conflict("What the upgrade moves has changed since it was acknowledged: check it again, then upgrade.");
      const result = await startProvision({
        intentPath,
        files: platform,
        now,
        // The file as this page read it, checked again under the apply's lock.
        ...(request.headers[versionHeader] !== undefined ? { version: request.headers[versionHeader] } : {}),
        upgrade: devices,
        acceptNewSeries: needed.newSeries.length > 0,
        acceptDowngrade: Object.keys(needed.downgrades).length > 0,
      });
      return result.started ? json(202, { started: true }) : conflict(result.reason);
    }),
  },
];
