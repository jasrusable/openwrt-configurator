// The Status graphs' points, kept by the server (src/status/history.ts: one a
// minute for a day, one every 15 minutes for 30 days, read whether or not a
// page is open): a range read whole once, then only what is new, while a page
// draws it. Which range the graphs show is one choice for them all, kept in
// this browser.
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { History, Range } from "../../../src/status/history";
import { mergeHistory, ranges } from "../../../src/status/history";
import { loadHistory } from "./api";

export type Point = [number, number];
export type { Range };

export const historyKey = (range: Range) => ["status-history", range] as const;

/** The newest bucket held: asked again from there, as it may still have been filling. */
const newest = (history: History) =>
  Math.max(0, ...Object.values(history).map((points) => points[points.length - 1]?.[0] ?? 0));

const useHistory = (range: Range) => {
  const queryClient = useQueryClient();
  const { bucketMs } = ranges[range];
  return useQuery({
    queryKey: historyKey(range),
    queryFn: async () => {
      const kept = queryClient.getQueryData<History>(historyKey(range));
      return kept ? mergeHistory(kept, await loadHistory(newest(kept), range), Date.now(), ranges[range]) : loadHistory(0, range);
    },
    // Asked twice a bucket, so a new point shows soon (at most every 5 minutes).
    refetchInterval: Math.min(bucketMs / 2, 5 * 60_000),
    staleTime: Math.min(bucketMs / 2, 5 * 60_000),
  });
};

// The range every graph shows: a per-viewer convenience, so in localStorage.
const rangeStorageKey = "onc-chart-range";
const listeners = new Set<() => void>();
const storedRange = (): Range => {
  try {
    return localStorage.getItem(rangeStorageKey) === "month" ? "month" : "day";
  } catch {
    return "day";
  }
};
let currentRange: Range = storedRange();

export const setChartRange = (range: Range) => {
  currentRange = range;
  try {
    localStorage.setItem(rangeStorageKey, range);
  } catch {
    // Storage blocked: the choice lasts this page.
  }
  listeners.forEach((listener) => listener());
};

/** Which range the graphs show: the last day, or the last 30 days. */
export const useChartRange = (): Range =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    () => currentRange
  );

/** A series in the range the graphs show, kept up to date, as [bucket start, mean] points. */
export const useSeries = (key: string): Point[] => {
  const points = useHistory(useChartRange()).data?.[key] ?? [];
  return points.map(([t, v]) => [t, v]);
};

/** The range switch a graph's card shows: every graph's range. */
export const useRangeSwitch = () => ({ value: useChartRange(), onChange: setChartRange });
