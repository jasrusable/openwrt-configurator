// What OpenWrt has out, and where each device stands against the settings
// (src/firmware/target.ts): from the draft, so a choice in the Firmware tab
// shows at once, the stored facts, and the releases (asked by the server at
// most once a day).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { firmwareRows, RunningFacts, updatesAvailable } from "../../../src/firmware/target";
import type { Intent } from "../../../src/intent/schema";
import { useDraftValue } from "../form/draft";
import { loadReleases, startUpgrade } from "./api";
import { intentKey } from "./intent";
import { provisionKey } from "./provision";
import { useDevices } from "./devices";

export const useReleases = () =>
  useQuery({ queryKey: ["openwrt-releases"], queryFn: loadReleases, staleTime: 3_600_000, retry: false });

/** What each device runs, as its stored facts say. */
export const useRunning = (): RunningFacts =>
  Object.fromEntries(Object.entries(useDevices().data?.facts ?? {}).map(([name, f]) => [name, f?.schema]));

/** Each device in Hardware, where it stands. */
export const useFirmwareRows = () => {
  const intent: Intent = useDraftValue();
  return firmwareRows({ intent, facts: useRunning(), releases: useReleases().data?.releases });
};

/** Start an upgrade (the apply job, its firmware step first); followed like any run. */
export const useStartUpgrade = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: startUpgrade,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: provisionKey }),
    // Refused as the file changed elsewhere: read it again for the next try.
    onError: () => queryClient.invalidateQueries({ queryKey: intentKey }),
  });
};

/** Whether updates are available (src/firmware/target.ts updatesAvailable): what every update dot says. */
export const useUpdates = () => updatesAvailable(useFirmwareRows(), useReleases().data?.releases);
