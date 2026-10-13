// What the network is doing now, as the server's collector last read it
// (src/status/collector.ts): one read every page shares, so moving between
// pages shows it at once. Asked while a page that shows it is open (React
// Query stops when it unmounts, and when the browser tab is in the
// background); each ask also tells the server someone is looking, so it
// reads the devices fast.
import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NetworkStatus } from "../../../src/status/network";
import { loadLatestRelease, loadNetworkStatus, restartService, runSpeedTest, runWifiSurvey } from "./api";

export const statusKey = ["network-status"] as const;

/** As fast as the collector reads while someone looks (watchedEveryMs). */
const every = 10_000;

/** Asked once, in the background, as the app opens: every page then opens on it. */
export const prefetchNetworkStatus = (queryClient: QueryClient) =>
  queryClient.prefetchQuery({ queryKey: statusKey, queryFn: loadNetworkStatus, staleTime: 0 });

export const useNetworkStatus = () =>
  useQuery({
    queryKey: statusKey,
    queryFn: loadNetworkStatus,
    refetchInterval: every,
    staleTime: every,
    // A slow answer should not make the page flicker between states.
    placeholderData: (previous) => previous,
  });

/** Throughput as last read, if that was lately: an old one is not what is happening now. */
export const throughputNow = (status: NetworkStatus | undefined, now = Date.now()) =>
  status?.throughput && status.readAt !== undefined && now - status.readAt < 90_000 ? status.throughput : {};

/** A Status fix: restart a service, then read again. */
export const useRestartService = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ device, service }: { device: string; service: string }) => restartService(device, service),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: statusKey }),
  });
};

export const useSpeedTest = () => useMutation({ mutationFn: runSpeedTest });

/** Each access point's survey: on request, as a scan can briefly disturb its clients. */
export const useWifiSurvey = () => useMutation({ mutationFn: runWifiSurvey });

/** OpenWrt's latest release: asked once a day at most (the server keeps it). */
export const useLatestRelease = () =>
  useQuery({ queryKey: ["openwrt-release"], queryFn: loadLatestRelease, staleTime: 3_600_000, retry: false });
