// Server state for the intent file, through React Query.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadIntent, NoSettingsError, SaveError, saveIntent } from "./api";
import { prefetchApplyPlan } from "./devices";
import { provisionKey } from "./provision";

export const intentKey = ["intent"] as const;

export const useIntent = () =>
  useQuery({
    queryKey: intentKey,
    queryFn: loadIntent,
    // None saved yet is an answer (the first run), not a failure to try again.
    retry: (failures, error) => !(error instanceof NoSettingsError) && failures < 1,
  });

export const useSaveIntent = ({ prefetchPlan = true }: { prefetchPlan?: boolean } = {}) => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveIntent,
    // Saved elsewhere since: read it again; the draft keeps its edits over it.
    onError: (error) => {
      if (error instanceof SaveError && error.changedElsewhere) void queryClient.invalidateQueries({ queryKey: intentKey });
    },
    // What the server saved, defaults applied, is the new truth.
    onSuccess: (saved) => {
      queryClient.setQueryData(intentKey, saved);
      // The draft changed, so what a provision would change did too.
      queryClient.invalidateQueries({ queryKey: provisionKey });
      // Not when Save and Apply is about to start the run: that read would
      // log in to the devices as the run does.
      if (prefetchPlan) void prefetchApplyPlan(queryClient);
    },
  });
};
