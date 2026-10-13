// What the network is doing (GET /api/status), as the collector last read it
// (src/status/collector.ts), at once; each request also marks that someone
// is looking, so it reads fast. With no collector running (its snapshot old
// or missing) the request reads the devices itself; while an apply runs,
// never: what was read before, marked so. And the graphs' points
// (GET /api/history, or /api/history/<since ms>): whole, or what is new.
import { currentStatus, markWanted, readHistory } from "../../status/collector";
import { historySince } from "../../status/history";
import { ApiContext, json, refuse, respond, Route } from "../router";

export const statusRoutes = ({ intentPath, platform, statusDir, now }: ApiContext): Route[] => [
  {
    path: "/api/status",
    GET: async () => {
      markWanted(platform, statusDir, now());
      return respond(await currentStatus({ intentPath, platform, dir: statusDir, now }));
    },
  },
  {
    path: "/api/history",
    prefix: true,
    GET: async ({ path }) => {
      const since = Number(path.split("/")[3] ?? 0);
      if (!Number.isFinite(since)) return refuse("not-found", "Not a time.");
      return json(200, historySince(readHistory(platform, statusDir), since));
    },
  },
];
