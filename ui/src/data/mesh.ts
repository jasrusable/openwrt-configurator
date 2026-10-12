// A mesh link's speed, on request: the throughput meter runs a few seconds.
import { useMutation } from "@tanstack/react-query";
import { measureMeshLink } from "./api";

export const useMeasureLink = () => useMutation({ mutationFn: measureMeshLink });
