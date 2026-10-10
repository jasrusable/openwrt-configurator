// Every page, in sidebar order. Adding a page is adding a line here.
import {
  IconAdjustments,
  IconFlame,
  IconDevices,
  IconNetwork,
  IconShieldLock,
  IconWifi,
  IconWorld,
} from "@tabler/icons-react";
import { DevicesPage } from "./DevicesPage";
import { DnsPage } from "./DnsPage";
import { FirewallPage, firewallPages } from "./firewall";
import { GeneralPage } from "./GeneralPage";
import { InternetPage } from "./InternetPage";
import { NetworksPage } from "./NetworksPage";
import { WifiPage } from "./WifiPage";

export const pages = [
  { id: "general", label: "General", icon: IconAdjustments, Page: GeneralPage },
  { id: "internet", label: "Internet", icon: IconWorld, Page: InternetPage },
  { id: "networks", label: "Networks", icon: IconNetwork, Page: NetworksPage },
  { id: "wifi", label: "Wi-Fi", icon: IconWifi, Page: WifiPage },
  {
    id: "firewall",
    label: "Firewall",
    icon: IconFlame,
    Page: FirewallPage,
    children: firewallPages,
  },
  { id: "dns", label: "DNS", icon: IconShieldLock, Page: DnsPage },
  { id: "devices", label: "Devices", icon: IconDevices, Page: DevicesPage },
] as const;


