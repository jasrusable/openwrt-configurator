// How deep each mesh node is, seen from the cabled ones: 1 for a cabled node's
// direct neighbour, one more for each hop beyond. Applying deepest first means
// a node is never cut off by a change to the one it is reached through (a new
// mesh key or channel). Pure: fed the routing tables the nodes report.
import { Probe } from "./deviceProbes";
import { parseRoutes } from "./status/device";

type View = { macs: string[]; routes: ReturnType<typeof parseRoutes> };

export const meshDepths = ({
  views,
  cabled,
}: {
  /** Each node's MACs (any of which batman may know it by) and best routes, by hostname. */
  views: Record<string, View>;
  /** The nodes on a cable: depth 0, and whose tables say the rest. */
  cabled: string[];
}): Record<string, number> => {
  const byMac = new Map(Object.entries(views).flatMap(([host, v]) => v.macs.map((mac) => [mac, host] as const)));
  // A node is known by its first interface's MAC, its next hop by the one on the link.
  const same = (a: string, b: string) => a === b || (!!byMac.get(a) && byMac.get(a) === byMac.get(b));
  const best: Record<string, number> = {};
  cabled.forEach((gateway) => {
    const routes = views[gateway]?.routes ?? [];
    const via = new Map(routes.map((r) => [r.originator, r.nexthop]));
    const depth = (mac: string, seen: Set<string> = new Set()): number => {
      const next = via.get(mac);
      if (!next || seen.has(mac)) return Infinity;
      if (same(next, mac)) return 1;
      const hop = routes.find((r) => same(r.originator, next))?.originator;
      return hop ? 1 + depth(hop, new Set([...seen, mac])) : Infinity;
    };
    routes.forEach(({ originator }) => {
      const host = byMac.get(originator);
      const d = depth(originator);
      if (host && Number.isFinite(d)) best[host] = Math.min(best[host] ?? Infinity, d);
    });
  });
  cabled.forEach((host) => (best[host] = 0));
  return best;
};

/** A node's MACs and routes, in one probe; no routes where batman does not run. */
export const parseMeshView = (stdout: string): View => {
  const [macs, table = ""] = stdout.split("---");
  return {
    macs: [...new Set(macs.split("\n").map((m) => m.trim().toLowerCase()).filter((m) => /^[0-9a-f:]{17}$/.test(m)))],
    routes: parseRoutes(table),
  };
};

export const meshView: Probe<View> = {
  command: "cat /sys/class/net/*/address 2>/dev/null; echo ---; batctl meshif bat0 originators -H 2>/dev/null || true",
  parse: ({ stdout }) => parseMeshView(stdout),
};
