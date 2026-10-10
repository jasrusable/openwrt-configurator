// Server state for the intent file, through React Query.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { loadIntent, saveIntent } from "./api";
import { provisionKey } from "./provision";

const intentKey = ["intent"] as const;

export const useIntent = () =>
  useQuery({ queryKey: intentKey, queryFn: loadIntent });

export const useSaveIntent = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveIntent,
    // What the server saved, defaults applied, is the new truth.
    onSuccess: (saved) => {
      queryClient.setQueryData(intentKey, saved);
      // The draft changed, so what a provision would change did too.
      queryClient.invalidateQueries({ queryKey: provisionKey });
    },
  });
};
