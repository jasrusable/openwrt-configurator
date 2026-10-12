// This app's own SSH public key: refetched on each visit to System, so a
// changed key path (once saved) is followed.
import { useQuery } from "@tanstack/react-query";
import { loadOwnKey } from "./api";

export const useOwnKey = () => useQuery({ queryKey: ["own-key"], queryFn: loadOwnKey });
