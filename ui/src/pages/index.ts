// Every page, in sidebar order. Adding a page is adding a line here.
import {
  IconAdjustments,
  IconAntenna,
  IconBroadcast,
  IconFlame,
  IconDevices,
  IconNetwork,
  IconShieldLock,
  IconWifi,
  IconWorld,
} from "@tabler/icons-react";
import { HardwarePage } from "./HardwarePage";
import { DnsPage } from "./DnsPage";
import { FirewallPage } from "./firewall";
import { GeneralPage } from "./GeneralPage";
import { InternetPage } from "./InternetPage";
import { NetworksPage } from "./NetworksPage";
import { RadiosPage } from "./RadiosPage";
import { WifiPage } from "./WifiPage";

export const pages = [
  { id: "general", label: "General", icon: IconAdjustments, Page: GeneralPage },
  { id: "internet", label: "Internet", icon: IconWorld, Page: InternetPage },
  // Always shown, indented under Internet; its pages are tabs.
  { id: "firewall", label: "Firewall", icon: IconFlame, Page: FirewallPage, indent: true },
  { id: "networks", label: "Networks", icon: IconNetwork, Page: NetworksPage },
  // A heading for its two pages, which are always shown under it.
  { header: true, id: "wifi", label: "Wi-Fi", icon: IconWifi, to: "ssids" },
  { id: "ssids", label: "SSIDs", icon: IconAntenna, Page: WifiPage, indent: true },
  { id: "radios", label: "Radios", icon: IconBroadcast, Page: RadiosPage, indent: true },
  { id: "dns", label: "DNS & DHCP", icon: IconShieldLock, Page: DnsPage },
  { id: "hardware", label: "Hardware", icon: IconDevices, Page: HardwarePage },
] as const;


