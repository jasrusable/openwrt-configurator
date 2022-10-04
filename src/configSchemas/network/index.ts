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
    })
    .strict()
);

export const networkResetCommands = [
  "while uci -q delete network.@interface[0]; do :; done",
  "while uci -q delete network.@device[0]; do :; done",
  "while uci -q delete network.@bridge-vlan[0]; do :; done",
  "while uci -q delete network.@switch_vlan[0]; do :; done",
  "while uci -q delete network.@switch[0]; do :; done",
];
