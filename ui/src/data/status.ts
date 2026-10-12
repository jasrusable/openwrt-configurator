// What the network is doing now, read from the devices: polled only while a
// page that shows it is open (React Query stops when it unmounts, and when the
// tab is in the background).
import { QueryClient, useQuery } from "@tanstack/react-query";
import { loadNetworkStatus } from "./api";

export const statusKey = ["network-status"] as const;

/** Read once, in the background, as the app opens: the Overview then opens on it. */
export const prefetchNetworkStatus = (queryClient: QueryClient) =>
  queryClient.prefetchQuery({ queryKey: statusKey, queryFn: loadNetworkStatus, staleTime: 0 });

export const useNetworkStatus = () =>
  useQuery({
    queryKey: statusKey,
    queryFn: loadNetworkStatus,
    refetchInterval: 30_000,
    // Read as the app opened: the Overview opens on it rather than reading again at once.
    staleTime: 15_000,
    // A slow device should not make the page flicker between states.
    placeholderData: (previous) => previous,
  });
