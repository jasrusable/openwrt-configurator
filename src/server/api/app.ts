// This app's own updates on a router (src/appUpdate.ts): where it stands, a
// check now (the feeds' index fetched again), and the update, which never
// starts during an apply (an apply on this router runs apk too).
import { appUpdate, refreshAppIndex, startAppUpdate } from "../../appUpdate";
import { applyRunning } from "../../apply/job";
import { problem } from "../../problem";
import { ApiContext, json, problemResponse, Route } from "../router";

export const appRoutes = ({ intentPath, platform, now }: ApiContext): Route[] => {
  const state = async () => json(200, (await appUpdate({ intentPath, platform, now })) ?? { here: false });
  return [
    { path: "/api/app", GET: state },
    {
      path: "/api/app/check",
      POST: async () => {
        await refreshAppIndex({ intentPath, platform, now, maxAgeMs: 0 });
        return state();
      },
    },
    {
      path: "/api/app/update",
      POST: async () => {
        if (await applyRunning({ intentPath, files: platform, now })) {
          return problemResponse(problem("conflict", "An apply is running: update once it is done."));
        }
        const result = await startAppUpdate({ intentPath, platform, now });
        if ("refused" in result) return problemResponse(problem("conflict", result.refused));
        return json(202, result.started);
      },
    },
  ];
};
