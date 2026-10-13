// Add hardware: what is on the network (fetched when the page opens, never
// polled), reading the picked device, and taking it on.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adoptDevice, inspectDevice, loadCandidates } from "./api";

export const useCandidates = () =>
  // Not retried: a router that cannot be asked says so at once, with why.
  useQuery({ queryKey: ["discover"], queryFn: loadCandidates, staleTime: 0, gcTime: 0, retry: false });

export const useInspect = () => useMutation({ mutationFn: inspectDevice });

export const useAdopt = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ address, name }: { address: string; name: string }) => adoptDevice(address, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }),
  });
};
