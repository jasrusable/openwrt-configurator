// The Status graphs' points, kept by the server (src/status/history.ts: one
// a minute, a day of them, read whether or not a page is open): read whole
// once, then only what is new, while a page draws them.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { History } from "../../../src/status/history";
import { bucketMs, mergeHistory } from "../../../src/status/history";
import { loadHistory } from "./api";

export type Point = [number, number];

export const historyKey = ["status-history"] as const;

/** The newest minute held: asked again from there, as it may still have been filling. */
const newest = (history: History) =>
  Math.max(0, ...Object.values(history).map((points) => points[points.length - 1]?.[0] ?? 0));

const useHistory = () => {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: historyKey,
    queryFn: async () => {
      const kept = queryClient.getQueryData<History>(historyKey);
      return kept ? mergeHistory(kept, await loadHistory(newest(kept))) : loadHistory(0);
    },
    // A point a minute: asked twice a minute, so a new one shows soon.
    refetchInterval: bucketMs / 2,
    staleTime: bucketMs / 2,
  });
};

/** A series, kept up to date, as [minute, mean] points. */
export const useSeries = (key: string): Point[] => {
  const points = useHistory().data?.[key] ?? [];
  return points.map(([t, v]) => [t, v]);
};
