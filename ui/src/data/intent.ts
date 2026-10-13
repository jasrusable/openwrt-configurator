// Server state for the intent file, through React Query.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadIntent, SaveError, saveIntent } from "./api";
import { prefetchApplyDiff } from "./devices";
import { provisionKey } from "./provision";

export const intentKey = ["intent"] as const;

export const useIntent = () =>
  useQuery({ queryKey: intentKey, queryFn: loadIntent });

export const useSaveIntent = () => {
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
      // The draft changed, so what a provision would change did too: worked
      // out now, in the background, so Apply has it when opened.
      queryClient.invalidateQueries({ queryKey: provisionKey });
      void prefetchApplyDiff(queryClient);
    },
  });
};
