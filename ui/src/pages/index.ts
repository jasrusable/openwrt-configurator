// Every page, in sidebar order. Adding a page is adding a line here. A page
// with pages of its own shows them as tabs (Wi-Fi, Firewall). Names come from
// src/intent/places.ts, which every "Wi-Fi › Radios" in the text is built from.
// Each has an icon on its own colour in the sidebar, as macOS Settings does;
// page titles and tabs stay text only, so the icon is not repeated.
import {
  IconAdjustments,
  IconFlame,
  IconNetwork,
  IconRouter,
  IconShieldLock,
  IconWifi,
  IconWorld,
} from "@tabler/icons-react";
import { placeName } from "../../../src/intent/places";
import { DnsPage } from "./DnsPage";
import { FirewallPage } from "./firewall";
import { SystemPage } from "./SystemPage";
import { HardwarePage } from "./HardwarePage";
import { InternetPage } from "./InternetPage";
import { NetworksPage } from "./NetworksPage";
import { WifiSection } from "./wifi";

export const pages = [
  { id: "system", label: placeName("system"), icon: IconAdjustments, color: "gray", Page: SystemPage },
  { id: "internet", label: placeName("internet"), icon: IconWorld, color: "indigo", Page: InternetPage },
  { id: "networks", label: placeName("networks"), icon: IconNetwork, color: "green", Page: NetworksPage },
  { id: "wifi", label: placeName("wifi"), icon: IconWifi, color: "blue", Page: WifiSection },
  // After Networks: who may reach what is each network's access; this is the exceptions.
  { id: "firewall", label: placeName("firewall"), icon: IconFlame, color: "red", Page: FirewallPage },
  { id: "dns", label: placeName("dns"), icon: IconShieldLock, color: "violet", Page: DnsPage },
  { id: "hardware", label: placeName("hardware"), icon: IconRouter, color: "orange", Page: HardwarePage },
] as const;
