// Every page, in sidebar order. Adding a page is adding a line here.
import {
  IconAdjustments,
  IconDevices,
  IconNetwork,
  IconShieldLock,
  IconWifi,
  IconWorld,
} from "@tabler/icons-react";
import { DevicesPage } from "./DevicesPage";
import { DnsPage } from "./DnsPage";
import { GeneralPage } from "./GeneralPage";
import { InternetPage } from "./InternetPage";
import { NetworkPage } from "./NetworkPage";
import { WifiPage } from "./WifiPage";

export const pages = [
  { id: "general", label: "General", icon: IconAdjustments, Page: GeneralPage },
  { id: "internet", label: "Internet", icon: IconWorld, Page: InternetPage },
  { id: "network", label: "Network", icon: IconNetwork, Page: NetworkPage },
  { id: "wifi", label: "Wi-Fi", icon: IconWifi, Page: WifiPage },
  { id: "dns", label: "DNS", icon: IconShieldLock, Page: DnsPage },
  { id: "devices", label: "Devices", icon: IconDevices, Page: DevicesPage },
] as const;


