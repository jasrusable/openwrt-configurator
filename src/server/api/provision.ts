// Applying from the UI: where a run is and what the saved draft changes
// (GET), starting one (POST), and what it would change on each device, read
// from the devices now (GET /api/apply/diff, src/applyDiff.ts).
import { diffOf, readApplyDiff } from "../../applyDiff";
import { diffIntent } from "../../intent/diff";
import { lockoutReason } from "../../loginAccess";
import { jobPaths, jobState, provisionStatus, startProvision } from "../provisionJob";
import { ApiContext, json, problemResponse, respond, Route } from "../router";
import { problem } from "../../problem";
import { loadSettings, intentFileOrNothing } from "../../settings";
import { changedElsewhere } from "./intent";

const conflict = (message: string) => problemResponse(problem("conflict", message));

export const provisionRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => [
  {
    path: "/api/provision",
    GET: async () => {
      const status = await provisionStatus({ intentPath, files: platform });
      const draft = intentFileOrNothing(platform, intentPath) as { hardware?: { name: string }[] } | undefined;
      const live = intentFileOrNothing(platform, jobPaths(intentPath).live);
      return json(200, {
        ...status,
        devices: (draft?.hardware ?? []).map((d) => d.name),
        // Never provisioned from here: everything is new, so no diff.
        changes: live ? diffIntent(live, draft) : [],
      });
    },
    POST: async (request) => {
      // What the page showed is what gets applied: not a file saved since
      // in another tab or by the CLI.
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
      const result = await startProvision({ intentPath, files: platform, now });
      return result.started ? json(202, { started: true }) : conflict(result.reason);
    },
  },
  {
    path: "/api/apply/diff",
    GET: async () => {
      // Not while an apply runs: it would log in to devices mid-change.
      if ((await jobState({ intentPath, files: platform })).state === "running") return conflict("Settings are being applied.");
      // As the page gets it: each device's changes, or why it was not reached.
      return respond(await readApplyDiff({ intentPath, platform }), (reads) =>
        json(200, { devices: reads.map(diffOf) })
      );
    },
  },
];
