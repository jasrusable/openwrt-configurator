// What each device is (facts) and what an apply would change on it. Facts
// keep themselves fresh: a page that shows them asks, as it opens, for the
// stale ones to be read; the server decides which and how often (rests after
// a failure, one read at a time). Never polled.
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { loadApplyDiff, loadDevices, refreshDevices } from "./api";

const devicesKey = ["devices"] as const;
const diffKey = ["apply-diff"] as const;

/** The facts as last read, without reading anything. */
export const useDevices = () => useQuery({ queryKey: devicesKey, queryFn: loadDevices });

/** The facts, and a read of the stale ones as the page opens. */
export const useFreshDevices = () => {
  const devices = useDevices();
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: refreshDevices,
    onSuccess: (fresh) => {
      queryClient.setQueryData(devicesKey, fresh);
      queryClient.invalidateQueries({ queryKey: diffKey });
    },
  });
  const due = (devices.data?.stale.length ?? 0) > 0;
  useEffect(() => {
    if (due && refresh.isIdle) refresh.mutate();
  }, [due, refresh]);
  return { ...devices, reading: refresh.isPending };
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
