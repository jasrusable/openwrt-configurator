// Server state for provisioning: polled while a run is in progress.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadProvision, startProvision, undoLastApply } from "./api";
import { planKey } from "./devices";
import { intentKey } from "./intent";

export const provisionKey = ["provision"] as const;

export const useProvision = () =>
  useQuery({
    queryKey: provisionKey,
    queryFn: loadProvision,
    refetchInterval: (query) =>
      query.state.data?.state === "running" ? 1000 : false,
  });

export const useStartProvision = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startProvision,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: provisionKey }),
    // Refused, perhaps as the file changed elsewhere (409): read it again, and
    // what applying it would change, to review before another try.
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: intentKey });
      void queryClient.invalidateQueries({ queryKey: planKey });
    },
  });
};

/** Undo the last apply (the settings before it, applied again). The saved file changes too when asked. */
export const useUndoApply = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: undoLastApply,
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: provisionKey });
      void queryClient.invalidateQueries({ queryKey: intentKey });
    },
  });
};
