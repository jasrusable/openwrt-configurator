// Every page, in sidebar order. Adding a page is adding a line here. A page
// with pages of its own shows them as tabs (Wi-Fi, Firewall). Names come from
// src/intent/places.ts, which every "Wi-Fi › Radios" in the text is built from.
// Each has an icon on its own colour in the sidebar, as macOS Settings does;
// page titles and tabs stay text only, so the icon is not repeated.
import {
  IconAdjustments,
  IconFlame,
  IconLayoutDashboard,
  IconNetwork,
  IconRouter,
  IconShieldLock,
  IconWifi,
  IconLock,
  IconWorld,
} from "@tabler/icons-react";
import { placeName } from "../../../src/intent/places";
import { DnsPage } from "./DnsPage";
import { FirewallPage } from "./firewall";
import { VpnPage } from "./vpn";
import { SystemPage } from "./SystemPage";
import { HardwarePage } from "./HardwarePage";
import { InternetPage } from "./InternetPage";
import { NetworksPage } from "./NetworksPage";
import { StatusSection } from "./status";
import { WifiSection } from "./wifi";

export const pages = [
  { group: "status", id: "overview", label: placeName("overview"), icon: IconLayoutDashboard, color: "teal", Page: StatusSection },
  { group: "settings", id: "system", label: placeName("system"), icon: IconAdjustments, color: "gray", Page: SystemPage },
  { group: "settings", id: "internet", label: placeName("internet"), icon: IconWorld, color: "indigo", Page: InternetPage },
  { group: "settings", id: "networks", label: placeName("networks"), icon: IconNetwork, color: "green", Page: NetworksPage },
  { group: "settings", id: "wifi", label: placeName("wifi"), icon: IconWifi, color: "blue", Page: WifiSection },
  // After Networks: who may reach what is each network's access; this is the exceptions.
  { group: "settings", id: "firewall", label: placeName("firewall"), icon: IconFlame, color: "red", Page: FirewallPage },
  { group: "settings", id: "vpn", label: placeName("vpn"), icon: IconLock, color: "teal", Page: VpnPage },
  { group: "settings", id: "dns", label: placeName("dns"), icon: IconShieldLock, color: "violet", Page: DnsPage },
  { group: "settings", id: "hardware", label: placeName("hardware"), icon: IconRouter, color: "orange", Page: HardwarePage },
] as const;

/** The sidebar's groups, in order: what the network is doing, then how it is set up. */
export const groups = [
  { id: "status", label: "Status" },
  { id: "settings", label: "Settings" },
] as const;
