import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
} from "../../utils";
import {
  networkBridgeVlanSchema,
  oncNetworkBridgeVlanSchema,
} from "./bridgeVlan";
import { networkDeviceSchema, oncNetworkDeviceSchema } from "./device";
import { networkInterfaceSchema, oncNetworkInterfaceSchema } from "./interface";
import { networkSwitchSchema, oncNetworkSwitchSchema } from "./switch";
import {
  networkSwitchVlanSchema,
  oncNetworkSwitchVlanSchema,
} from "./switchVlan";

export const networkSchema = configSchema(
  z
    .object({
      switch: sectionSchema(networkSwitchSchema),
      switch_vlan: sectionSchema(networkSwitchVlanSchema),
      device: sectionSchema(networkDeviceSchema),
      "bridge-vlan": sectionSchema(networkBridgeVlanSchema),
      interface: sectionSchema(networkInterfaceSchema),
      globals: z.any()
    })
    .strict()
);

export const oncNetworkSchema = makeOncConfigSchema(
  z
    .object({
      switch: oncSectionSchema(oncNetworkSwitchSchema),
      switch_vlan: oncSectionSchema(oncNetworkSwitchVlanSchema),
      device: oncSectionSchema(oncNetworkDeviceSchema),
      "bridge-vlan": oncSectionSchema(oncNetworkBridgeVlanSchema),
      interface: oncSectionSchema(oncNetworkInterfaceSchema),
      globals: z.any()
    })
    .strict()
);

export const networkSectionsToReset = {
  network: {
    interface: true,
    device: true,
    "bridge-vlan": true,
    switch_vlan: true,
    switch: true,
  },
};
