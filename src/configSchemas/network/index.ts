import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  onlySectionTypes,
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

// Policy routing (a network out through a VPN tunnel) and WireGuard's peers,
// whose section type is the interface's name after "wireguard_": as written.
const anySection = z.object({}).passthrough();
const onlyPeerSections = onlySectionTypes(
  ["switch", "switch_vlan", "switch_port", "device", "bridge-vlan", "interface", "rule", "rule6", "route", "route6", "globals"],
  /^wireguard_[A-Za-z0-9_]+$/
);

export const networkSchema = configSchema(
  z
    .object({
      switch: sectionSchema(networkSwitchSchema),
      switch_vlan: sectionSchema(networkSwitchVlanSchema),
      device: sectionSchema(networkDeviceSchema),
      "bridge-vlan": sectionSchema(networkBridgeVlanSchema),
      interface: sectionSchema(networkInterfaceSchema),
      rule: sectionSchema(anySection),
      route: sectionSchema(anySection),
      globals: z.any()
    })
    .catchall(sectionSchema(anySection))
).superRefine(onlyPeerSections);

export const oncNetworkSchema = makeOncConfigSchema(
  z
    .object({
      switch: oncSectionSchema(oncNetworkSwitchSchema),
      switch_vlan: oncSectionSchema(oncNetworkSwitchVlanSchema),
      device: oncSectionSchema(oncNetworkDeviceSchema),
      "bridge-vlan": oncSectionSchema(oncNetworkBridgeVlanSchema),
      interface: oncSectionSchema(oncNetworkInterfaceSchema),
      rule: oncSectionSchema(anySection),
      route: oncSectionSchema(anySection),
      globals: z.any()
    })
    .catchall(oncSectionSchema(anySection))
).superRefine(onlyPeerSections);

