import { z } from "zod";

export const networkSwitchSchema = z
  .object({
    name: z.string(),
    reset: z.boolean(),
    enable_vlan: z.boolean(),
  })
  .passthrough();

export const oncNetworkSwitchSchema = networkSwitchSchema;
