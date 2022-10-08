import { z } from "zod";
import {
  configSchema,
  makeOncConfigSchema,
  oncSectionSchema,
  sectionSchema,
} from "../../utils";
import {
  oncWirelessWifiDeviceSchema,
  wirelessWifiDeviceSchema,
} from "./wifiDevice";
import {
  oncWirelessWifiIfaceSchema,
  wirelessWifiIfaceSchema,
} from "./wifiIface";

export const wirelessSchema = configSchema(
  z
    .object({
      "wifi-device": sectionSchema(wirelessWifiDeviceSchema),
      "wifi-iface": sectionSchema(wirelessWifiIfaceSchema),
    })
    .strict()
);

export const oncWirelessSchema = makeOncConfigSchema(
  z
    .object({
      "wifi-device": oncSectionSchema(oncWirelessWifiDeviceSchema),
      "wifi-iface": oncSectionSchema(oncWirelessWifiIfaceSchema),
    })
    .strict()
);

export const wirelessSectionsToReset = {
  wireless: {
    "wifi-device": true,
    "wifi-iface": true,
  },
};
