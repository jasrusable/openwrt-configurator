import { z } from "zod";

export const networkSwitchVlanSchema = z.object({
  device: z.string(),
  vlan: z.number(),
  ports: z.string(),
});

export const oncNetworkSwitchVlanSchema = networkSwitchVlanSchema;
