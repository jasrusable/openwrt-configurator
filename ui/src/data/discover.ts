// Add hardware: what is on the network (fetched when the page opens, never
// polled), reading the picked device, and taking it on.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { adoptDevice, inspectDevice, inspectResetDevice, loadCandidates, readoptDevice } from "./api";

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

/** A device in Hardware that was reset: read again, then taken back under its own name. */
export const useInspectReset = () =>
  useMutation({ mutationFn: ({ address, name }: { address: string; name: string }) => inspectResetDevice(address, name) });

export const useReadopt = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ address, name }: { address: string; name: string }) => readoptDevice(address, name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["devices"] }),
  });
};
