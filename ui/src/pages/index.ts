// Every page, in sidebar order, in its mode: Status (what the network is
// doing, read from the devices: the app opens here) and Settings (what it
// should be, the draft you edit and apply), each with its own sidebar, so
// live and draft never share a page. Adding a page is adding a line here. A
// page with pages of its own shows them as tabs (System, Wi-Fi, Firewall).
// Names come from src/intent/places.ts, which every "Wi-Fi › Radios" in the
// text is built from. Each has an icon on its own colour in the sidebar, as
// macOS Settings does; page titles and tabs stay text only.
import {
  IconAdjustments,
  IconCpu,
  IconDevices,
  IconTimeline,
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
import { SystemSection } from "./system";
import { HardwarePage } from "./HardwarePage";
import { InternetPage } from "./InternetPage";
import { NetworksPage } from "./NetworksPage";
import { OverviewPage } from "./status/OverviewPage";
import { ActivityPage } from "./status/ActivityPage";
import { ClientsPage } from "./status/ClientsPage";
import { DevicesPage } from "./status/DevicesPage";
import { InternetStatusPage } from "./status/InternetStatusPage";
import { WifiStatusPage } from "./status/WifiStatusPage";
import { WifiSection } from "./wifi";

export const statusPages = [
  { id: "overview", label: placeName("overview"), icon: IconLayoutDashboard, color: "teal", Page: OverviewPage },
  { id: "clients", label: placeName("clients"), icon: IconDevices, color: "cyan", Page: ClientsPage },
  { id: "devices", label: placeName("devices"), icon: IconCpu, color: "grape", Page: DevicesPage },
  { id: "internet", label: placeName("internet"), icon: IconWorld, color: "indigo", Page: InternetStatusPage },
  { id: "wifi", label: placeName("wifi"), icon: IconWifi, color: "blue", Page: WifiStatusPage },
  { id: "activity", label: placeName("activity"), icon: IconTimeline, color: "pink", Page: ActivityPage },
] as const;

/** Under /settings/<id>: the order a network is set up in, System (the app itself) last. */
export const settingsPages = [
  { id: "internet", label: placeName("internet"), icon: IconWorld, color: "indigo", Page: InternetPage },
  { id: "networks", label: placeName("networks"), icon: IconNetwork, color: "green", Page: NetworksPage },
  { id: "wifi", label: placeName("wifi"), icon: IconWifi, color: "blue", Page: WifiSection },
  // After Networks: who may reach what is each network's access; this is the exceptions.
  { id: "firewall", label: placeName("firewall"), icon: IconFlame, color: "red", Page: FirewallPage },
  { id: "vpn", label: placeName("vpn"), icon: IconLock, color: "teal", Page: VpnPage },
  { id: "dns", label: placeName("dns"), icon: IconShieldLock, color: "violet", Page: DnsPage },
  { id: "hardware", label: placeName("hardware"), icon: IconRouter, color: "orange", Page: HardwarePage },
  { id: "system", label: placeName("system"), icon: IconAdjustments, color: "gray", Page: SystemSection },
] as const;
