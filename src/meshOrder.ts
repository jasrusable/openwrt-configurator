// How deep each mesh node is, seen from the cabled ones: 1 for a cabled node's
// direct neighbour, one more for each hop beyond. Applying deepest first means
// a node is never cut off by a change to the one it is reached through (a new
// mesh key or channel). Pure: fed the routing tables the nodes report.
import { Probe } from "./deviceProbes";
import { parseRoutes } from "./status/device";

type View = { mac?: string; routes: ReturnType<typeof parseRoutes> };

export const meshDepths = ({
  views,
  cabled,
}: {
  /** Each node's own mesh address and best routes, by hostname. */
  views: Record<string, View>;
  /** The nodes on a cable: depth 0, and whose tables say the rest. */
  cabled: string[];
}): Record<string, number> => {
  const byMac = new Map(
    Object.entries(views).flatMap(([host, v]) => (v.mac ? [[v.mac, host] as const] : []))
  );
  const best: Record<string, number> = {};
  cabled.forEach((gateway) => {
    const routes = views[gateway]?.routes ?? [];
    const via = new Map(routes.map((r) => [r.originator, r.nexthop]));
    const depth = (mac: string, seen: Set<string> = new Set()): number => {
      const next = via.get(mac);
      if (!next || seen.has(mac)) return Infinity;
      if (next === mac) return 1;
      return 1 + depth(next, new Set([...seen, mac]));
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

/** A node's own mesh address and routes, in one probe; nothing where batman does not run. */
export const parseMeshView = (stdout: string): View => {
  const [mac, table = ""] = stdout.split("---");
  return { ...(mac.trim() ? { mac: mac.trim().toLowerCase() } : {}), routes: parseRoutes(table) };
};

export const meshView: Probe<View> = {
  command: "cat /sys/class/net/mesh0/address 2>/dev/null; echo ---; batctl meshif bat0 originators -H 2>/dev/null || true",
  parse: ({ stdout }) => parseMeshView(stdout),
};
