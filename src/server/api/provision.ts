// Applying from the UI: where a run is and what the saved draft changes
// (GET), starting one (POST, with the reviewed plan's `verify` and the
// version of the settings it was compiled from), and the change plan, read
// from the devices now (GET /api/apply/plan, src/applyPlan.ts).
import { ApplyPlan } from "../../applyPlan";
import { readApplyPlan } from "../../applyDiff";
import { applyRunning, jobPaths, provisionStatus, startProvision } from "../../apply/job";
import { diffIntent } from "../../intent/diff";
import { lockoutReason } from "../../loginAccess";
import { ApiContext, json, problemResponse, respond, Route, withBody } from "../router";
import { problem } from "../../problem";
import { loadSettings, intentFileOrNothing, writeIntentFile } from "../../settings";
import { changedElsewhere, versionHeader, versionOf } from "./intent";

const conflict = (message: string) => problemResponse(problem("conflict", message));

/**
 * The change plan as served: with the saved settings' version it was compiled
 * from, which starting the apply names (`?version=`), so what runs is what
 * was reviewed.
 */
export type ServedApplyPlan = ApplyPlan & { version: string };

/** A plan's `verify`: undefined when absent, null when not device names to hashes. */
const verifyOf = (value: unknown): Record<string, string> | undefined | null =>
  value === undefined
    ? undefined
    : value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string")
      ? (value as Record<string, string>)
      : null;

const started = (result: Awaited<ReturnType<typeof startProvision>>) =>
  result.started ? json(202, { started: true }) : problemResponse(result.problem);

export const provisionRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => [
  {
    path: "/api/provision",
    GET: async () => {
      const status = await provisionStatus({ intentPath, files: platform });
      const draft = intentFileOrNothing(platform, intentPath) as { hardware?: { name: string }[] } | undefined;
      const live = intentFileOrNothing(platform, jobPaths(intentPath).live);
      const previous = intentFileOrNothing(platform, jobPaths(intentPath).previous);
      return json(200, {
        ...status,
        // The server's clock, so a countdown to a deadline on it is right in a browser whose clock is not.
        serverTime: now(),
        devices: (draft?.hardware ?? []).map((d) => d.name),
        // Never provisioned from here: everything is new, so no diff.
        changes: live ? diffIntent(live, draft) : [],
        // What undoing the last apply would put back, if there is one to undo.
        ...(live && previous
          ? { previous: { appliedAt: status.applied.previous, changes: diffIntent(live, previous) } }
          : {}),
      });
    },
    POST: withBody(async (input, request) => {
      // The reviewed plan's state hashes: the run stops before arming if a device differs. None (the CLI, an older page): not checked.
      const verify = verifyOf(input.verify);
      if (verify === null) return problemResponse(problem("invalid", "verify is not an object of device names to state hashes."));
      // What the page showed is what gets applied: not a file saved since
      // in another tab or by the CLI. Said now; checked again holding the lock.
      if (changedElsewhere(platform, intentPath, request)) {
        return conflict("The settings were changed elsewhere since this page read them: reload, check, then apply.");
      }
      // Never provision what would not have been saved: a file edited by
      // hand, or saved under older rules, is refused here, not mid-run.
      const saved = await loadSettings(intentPath, platform);
      if (!saved.ok) return problemResponse(saved.error);
      // Said now, not minutes later in the log (the run refuses it too).
      const lockout = await lockoutReason(saved.value.intent, platform);
      if (lockout) return conflict(lockout);
      const version = request.headers[versionHeader];
      return started(await startProvision({ intentPath, files: platform, now, ...(verify ? { verify } : {}), ...(version ? { version } : {}) }));
    }),
  },
  {
    // Undo the last apply: the settings that were live before it, applied
    // again, with the checks a normal apply has. `restoreSettings` also
    // makes them the saved settings (the file replaced kept as a backup),
    // once the apply's lock is held; otherwise the saved file is untouched
    // (and shows as changes to apply again).
    path: "/api/provision/undo",
    POST: withBody(async (input, request) => {
      if (await applyRunning({ intentPath, files: platform })) return conflict("Settings are being applied.");
      const previous = jobPaths(intentPath).previous;
      const restored = intentFileOrNothing(platform, previous);
      if (restored === undefined) {
        return problemResponse(problem("not-found", "There is no earlier apply to go back to."));
      }
      const loaded = await loadSettings(previous, platform);
      if (!loaded.ok) return problemResponse(loaded.error);
      const lockout = await lockoutReason(loaded.value.intent, platform);
      if (lockout) return conflict(lockout);
      const restore = input.restoreSettings === true;
      if (restore && changedElsewhere(platform, intentPath, request)) {
        return conflict("The settings were changed elsewhere since this page read them: reload, check, then undo.");
      }
      const version = request.headers[versionHeader];
      return started(
        await startProvision({
          intentPath,
          files: platform,
          now,
          undo: true,
          ...(restore
            ? {
                ...(version ? { version } : {}),
                prepare: () => writeIntentFile(platform, intentPath, restored, { keepOld: "always", at: now() }),
              }
            : { source: previous }),
        })
      );
    }),
  },
  {
    path: "/api/apply/plan",
    GET: async () => {
      // Not while an apply runs: it would log in to devices mid-change.
      if (await applyRunning({ intentPath, files: platform })) return conflict("Settings are being applied.");
      // Read before the plan: a save meanwhile makes the plan's version the
      // older one, so starting from it is refused rather than applying unreviewed settings.
      const version = versionOf(platform, intentPath);
      return respond(await readApplyPlan({ intentPath, platform, now }), (plan) => json(200, { ...plan, version } satisfies ServedApplyPlan));
    },
  },
];
