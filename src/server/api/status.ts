// What the network is doing (GET /api/status), as the collector last read it
// (src/status/collector.ts), at once; each request also marks that someone
// is looking, so it reads fast. With no collector running (its snapshot old
// or missing) the request reads the devices itself; while an apply runs,
// never: what was read before, marked so. And the graphs' points
// (GET /api/history, or /api/history/<since ms>; /api/history/month for 30
// days at 15 minutes): whole, or what is new. Every event kept
// (GET /api/events[/<since ms>]: the snapshot carries only the latest), and
// one client as remembered, with its own series (GET /api/clients/<mac>).
import { rebootsAsked, withRebooting } from "../../status/actions";
import { currentStatus, markWanted, readClientHistory, readEvents, readHistory, readRegistry } from "../../status/collector";
import { map } from "../../result";
import { historyOfClient, historySince, Range, ranges } from "../../status/history";
import { ApiContext, json, refuse, respond, Route } from "../router";

export const statusRoutes = ({ intentPath, platform, statusDir, now }: ApiContext): Route[] => [
  {
    path: "/api/status",
    GET: async () => {
      markWanted(platform, statusDir, now());
      // Devices on their way through a reboot, said as of this request: the
      // snapshot may be older than the reboot.
      const asked = rebootsAsked(platform, intentPath);
      return respond(map(await currentStatus({ intentPath, platform, dir: statusDir, now }), (status) => withRebooting(status, asked, now())));
    },
  },
  {
    path: "/api/history",
    prefix: true,
    // /api/history[/<since>] is the day's points; /api/history/month[/<since>] the month's.
    GET: async ({ path }) => {
      const [first, second] = path.split("/").slice(3);
      const range: Range = first === "month" ? "month" : "day";
      const since = Number((range === "month" ? second : first) ?? 0);
      if (!Number.isFinite(since)) return refuse("not-found", "Not a time.");
      return json(200, historySince(readHistory(platform, statusDir, range), since, ranges[range]));
    },
  },
  {
    path: "/api/events",
    prefix: true,
    GET: async ({ path }) => {
      const since = Number(path.split("/")[3] ?? 0);
      if (!Number.isFinite(since)) return refuse("not-found", "Not a time.");
      return json(200, readEvents(platform, statusDir).filter((e) => e.at > since));
    },
  },
  {
    path: "/api/clients",
    prefix: true,
    GET: async ({ path }) => {
      const mac = decodeURIComponent(path.split("/")[3] ?? "").toLowerCase();
      if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(mac)) return refuse("not-found", "Not a MAC address.");
      const known = readRegistry(platform, statusDir)?.clients[mac];
      return json(200, { ...(known ? { known } : {}), history: historyOfClient(readClientHistory(platform, statusDir), mac) });
    },
  },
];
