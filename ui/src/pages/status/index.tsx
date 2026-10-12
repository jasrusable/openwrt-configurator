// Status: the network now, as tabs above each page's title (as Wi-Fi's).
import { useParams } from "react-router";
import { SectionNav } from "../../kit/layout";
import { SectionTabs } from "../../kit/SectionTabs";
import { OverviewPage } from "../OverviewPage";
import { ActivityTab } from "./ActivityTab";
import { ClientsTab } from "./ClientsTab";
import { DevicesTab } from "./DevicesTab";
import { InternetTab } from "./InternetTab";
import { WifiTab } from "./WifiTab";

const tabs = [
  { value: "overview", label: "Overview", path: "/overview" },
  { value: "clients", label: "Clients", path: "/overview/clients" },
  { value: "internet", label: "Internet", path: "/overview/internet" },
  { value: "wifi", label: "Wi-Fi", path: "/overview/wifi" },
  { value: "devices", label: "Devices", path: "/overview/devices" },
  { value: "activity", label: "Activity", path: "/overview/activity" },
];

const pages = { clients: ClientsTab, internet: InternetTab, wifi: WifiTab, devices: DevicesTab, activity: ActivityTab };

export const StatusSection = () => {
  const [first = ""] = (useParams()["*"] ?? "").split("/");
  const tab = first in pages ? (first as keyof typeof pages) : "overview";
  const Page = tab === "overview" ? OverviewPage : pages[tab];
  return (
    <SectionNav.Provider value={<SectionTabs tabs={tabs} tab={tab} />}>
      <Page />
    </SectionNav.Provider>
  );
};
