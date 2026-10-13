// What the network is doing now, read from the devices: polled only while a
// Status page that shows it is open (React Query stops when it unmounts, and
// when the browser tab is in the background), each page at its own pace and
// with its own reads (the Internet checks, the log).
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { StatusView } from "../../../src/status/read";
import { loadLatestRelease, loadNetworkStatus, restartService, runSpeedTest, runWifiSurvey } from "./api";

export const statusKey = (view: StatusView = "overview") => ["network-status", view] as const;

/** How often each page reads: Performance's latency and throughput move, the devices' health less so. */
const every: Record<StatusView, number> = {
  overview: 30_000,
  clients: 15_000,
  performance: 10_000,
  devices: 30_000,
  activity: 30_000,
};

/** Read once, in the background, as the app opens: the Overview then opens on it. */
export const prefetchNetworkStatus = (queryClient: QueryClient) =>
  queryClient.prefetchQuery({ queryKey: statusKey(), queryFn: () => loadNetworkStatus(), staleTime: 0 });

export const useNetworkStatus = (view: StatusView = "overview") =>
  useQuery({
    queryKey: statusKey(view),
    queryFn: () => loadNetworkStatus(view),
    refetchInterval: every[view],
    // Read as the app opened: the page opens on it rather than reading again at once.
    staleTime: 15_000,
    // A slow device should not make the page flicker between states.
    placeholderData: (previous) => previous,
  });

/** A Status fix: restart a service, then read again. */
export const useRestartService = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ device, service }: { device: string; service: string }) => restartService(device, service),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["network-status"] }),
  });
};

export const useSpeedTest = () => useMutation({ mutationFn: runSpeedTest });

/** Each access point's survey: on request, as a scan can briefly disturb its clients. */
export const useWifiSurvey = () => useMutation({ mutationFn: runWifiSurvey });

/** OpenWrt's latest release: asked once a day at most (the server keeps it). */
export const useLatestRelease = () =>
  useQuery({ queryKey: ["openwrt-release"], queryFn: loadLatestRelease, staleTime: 3_600_000, retry: false });
