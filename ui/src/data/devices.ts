// What each device is (facts) and what an apply would change on it. Facts
// keep themselves fresh: a page that shows them asks, as it opens, for the
// stale ones to be read; the server decides which and how often (rests after
// a failure, one read at a time). Never polled.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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

/** Fetched afresh on each visit to the Apply page, so it follows saves and runs. */
export const useApplyDiff = () => useQuery({ queryKey: diffKey, queryFn: loadApplyDiff });
