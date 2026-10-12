// Every page, in sidebar order. Adding a page is adding a line here. A page
// with pages of its own shows them as tabs (Wi-Fi, Firewall).
import {
  IconAdjustments,
  IconDevices,
  IconFlame,
  IconNetwork,
  IconShieldLock,
  IconWifi,
  IconWorld,
} from "@tabler/icons-react";
import { DnsPage } from "./DnsPage";
import { FirewallPage } from "./firewall";
import { SystemPage } from "./SystemPage";
import { HardwarePage } from "./HardwarePage";
import { InternetPage } from "./InternetPage";
import { NetworksPage } from "./NetworksPage";
import { WifiSection } from "./wifi";

export const pages = [
  { id: "system", label: "System", icon: IconAdjustments, Page: SystemPage },
  { id: "internet", label: "Internet", icon: IconWorld, Page: InternetPage },
  { id: "networks", label: "Networks", icon: IconNetwork, Page: NetworksPage },
  { id: "wifi", label: "Wi-Fi", icon: IconWifi, Page: WifiSection },
  // After Networks: who may reach what is each network's access; this is the exceptions.
  { id: "firewall", label: "Firewall", icon: IconFlame, Page: FirewallPage },
  { id: "dns", label: "DNS & DHCP", icon: IconShieldLock, Page: DnsPage },
  { id: "hardware", label: "Hardware", icon: IconDevices, Page: HardwarePage },
] as const;
