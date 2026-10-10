// The firewall, laid out as LuCI's Network › Firewall: General settings (the
// defaults and zones), Port forwards and Traffic rules, as tabs above each
// page's title. A zone's page is under General settings (/firewall/zones/1).
import { Tabs } from "@mantine/core";
import { useNavigate, useParams } from "react-router";
import { SectionNav } from "../../kit/layout";
import { GeneralSettingsPage } from "./GeneralSettingsPage";
import { PortForwardsPage } from "./PortForwardsPage";
import { RulesPage } from "./RulesPage";

const tabs = [
  { value: "general", label: "General settings", path: "/firewall" },
  {
    value: "port-forwards",
    label: "Port forwards",
    path: "/firewall/port-forwards",
  },
  { value: "rules", label: "Traffic rules", path: "/firewall/rules" },
];

const FirewallTabs = ({ tab }: { tab: string }) => {
  const navigate = useNavigate();
  return (
    <Tabs
      value={tab}
      onChange={(value) =>
        navigate(tabs.find((t) => t.value === value)?.path ?? "/firewall")
      }
    >
      <Tabs.List>
        {tabs.map((t) => (
          <Tabs.Tab key={t.value} value={t.value}>
            {t.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
};

export const FirewallPage = () => {
  const [first = "", ...rest] = (useParams()["*"] ?? "").split("/");
  const sub = rest.join("/");
  const page =
    first === "port-forwards" ? (
      <PortForwardsPage sub={sub} />
    ) : first === "rules" ? (
      <RulesPage sub={sub} />
    ) : (
      // /firewall and /firewall/zones/<n>: the zones live here.
      <GeneralSettingsPage sub={first === "zones" ? sub : ""} />
    );
  const tab =
    first === "port-forwards" || first === "rules" ? first : "general";
  return (
    <SectionNav.Provider value={<FirewallTabs tab={tab} />}>
      {page}
    </SectionNav.Provider>
  );
};
