// Server state for provisioning: polled while a run is in progress.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadProvision, startProvision, undoLastApply } from "./api";
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
    mutationFn: (verify?: Record<string, string>) => startProvision(verify),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: provisionKey }),
    // Refused, perhaps as the file changed elsewhere (409): read it again, so
    // the next try carries its new version rather than failing until a reload.
    onError: () => queryClient.invalidateQueries({ queryKey: intentKey }),
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
