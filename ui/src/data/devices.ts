// What each device is (facts, read on request) and what an apply would change
// on it. Never polled: facts change only when the devices are read again.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadApplyDiff, loadDeviceFacts, readDevicesNow } from "./api";

const factsKey = ["device-facts"] as const;
const diffKey = ["apply-diff"] as const;

export const useDeviceFacts = () => useQuery({ queryKey: factsKey, queryFn: loadDeviceFacts });

export const useReadDevices = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: readDevicesNow,
    onSuccess: ({ facts }) => {
      queryClient.setQueryData(factsKey, facts);
      queryClient.invalidateQueries({ queryKey: diffKey });
    },
  });
};

/** Fetched afresh on each visit to the Apply page, so it follows saves and runs. */
export const useApplyDiff = () => useQuery({ queryKey: diffKey, queryFn: loadApplyDiff });
