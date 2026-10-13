// What each device is (facts) and what an apply would change on it (the plan). Facts
// keep themselves fresh: a page that shows them asks, as it opens, for the
// stale ones to be read; the server decides which and how often (rests after
// a failure, one read at a time). Never polled.
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadApplyPlan, loadDevices, refreshDevices } from "./api";

const devicesKey = ["devices"] as const;
export const planKey = ["apply-plan"] as const;

/** The facts as last read, without reading anything. */
export const useDevices = () => useQuery({ queryKey: devicesKey, queryFn: loadDevices });

/**
 * The facts, and a read of the stale ones as the page opens. A query, not a
 * mutation, so pages asking at once share one read; keyed by which devices
 * are stale, and asked again for the same ones only after the server's rest
 * for a failed read (10 minutes), as a page opens.
 */
export const useFreshDevices = () => {
  const devices = useDevices();
  const queryClient = useQueryClient();
  const stale = devices.data?.stale ?? [];
  const refresh = useQuery({
    queryKey: ["devices-refresh", ...stale],
    enabled: stale.length > 0,
    staleTime: 10 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
    queryFn: async () => {
      const fresh = await refreshDevices();
      queryClient.setQueryData(devicesKey, fresh);
      void queryClient.invalidateQueries({ queryKey: planKey });
      return fresh;
    },
  });
  return { ...devices, reading: refresh.isFetching };
};

/**
 * Read the change plan now, in the background: as the app opens and after
 * each save, so the Apply sheet has it before it is opened. Never throws.
 */
export const prefetchApplyPlan = (queryClient: QueryClient) =>
  queryClient.prefetchQuery({ queryKey: planKey, queryFn: loadApplyPlan, staleTime: 0 });

/**
 * The change plan (src/applyPlan.ts), read from the devices afresh as the
 * Apply sheet opens, so it follows saves and runs; not while an apply is
 * running, when they hold half of it. What was read before shows meanwhile,
 * with its age.
 */
export const useApplyPlan = (enabled = true) =>
  // Fresh for half a minute: opening Apply just after a save (which read it) reads it once.
  useQuery({ queryKey: planKey, queryFn: loadApplyPlan, enabled, refetchOnWindowFocus: false, staleTime: 30_000 });
