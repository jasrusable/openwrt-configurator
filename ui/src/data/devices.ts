// What each device is (facts) and what an apply would change on it. Facts
// keep themselves fresh: a page that shows them asks, as it opens, for the
// stale ones to be read; the server decides which and how often (rests after
// a failure, one read at a time). Never polled.
import { QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadApplyDiff, loadDevices, refreshDevices } from "./api";

const devicesKey = ["devices"] as const;
const diffKey = ["apply-diff"] as const;

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
      void queryClient.invalidateQueries({ queryKey: diffKey });
      return fresh;
    },
  });
  return { ...devices, reading: refresh.isFetching };
};

/**
 * Read the diff now, in the background: as the app opens and after each save,
 * so the Apply page has it before it is opened. Never throws.
 */
export const prefetchApplyDiff = (queryClient: QueryClient) =>
  queryClient.prefetchQuery({ queryKey: diffKey, queryFn: loadApplyDiff, staleTime: 0 });

/**
 * Read from the devices afresh on each visit to the Apply page, so it follows
 * saves and runs; not while an apply is running, when they hold half of it.
 * What was read before shows meanwhile.
 */
export const useApplyDiff = (enabled = true) =>
  // Fresh for half a minute: opening Apply just after a save (which read it) reads it once.
  useQuery({ queryKey: diffKey, queryFn: loadApplyDiff, enabled, refetchOnWindowFocus: false, staleTime: 30_000 });
