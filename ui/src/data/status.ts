// What the network is doing now, read from the devices: polled only while a
// page that shows it is open (React Query stops when it unmounts, and when the
// tab is in the background).
import { useQuery } from "@tanstack/react-query";
import { loadNetworkStatus } from "./api";

export const useNetworkStatus = () =>
  useQuery({
    queryKey: ["network-status"],
    queryFn: loadNetworkStatus,
    refetchInterval: 30_000,
    // A slow device should not make the page flicker between states.
    placeholderData: (previous) => previous,
  });
