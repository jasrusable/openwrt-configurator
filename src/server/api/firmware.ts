// System › Firmware: what OpenWrt has out (src/firmware/releases.ts), asked
// when the tab opens if the kept answer is a day old; and an upgrade,
// started as the apply job with its firmware step first (provision
// --upgrade): one change at a time, the collector paused, the saved settings
// applied once the devices are back. Where each device stands is worked out
// in the page, from the draft and the facts (src/firmware/target.ts).
import { readReleases } from "../../firmware/releases";
import { selfUpgradeResultKey } from "../../firmware/self";
import { read } from "../../store";
import { namePattern } from "../../intent/validators";
import { lockoutReason } from "../../loginAccess";
import { problem } from "../../problem";
import { loadSettings } from "../../settings";
import { startProvision } from "../provisionJob";
import { ApiContext, json, problemResponse, Route, withBody } from "../router";
import { changedElsewhere } from "./intent";

const conflict = (message: string) => problemResponse(problem("conflict", message));

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
      const result = await startProvision({
        intentPath,
        files: platform,
        now,
        upgrade: devices,
        acceptNewSeries: input.acceptNewSeries === true,
        acceptDowngrade: input.acceptDowngrade === true,
      });
      return result.started ? json(202, { started: true }) : conflict(result.reason);
    }),
  },
];
