// The firewall's own settings, as tabs above each page's title: port
// forwards and rules. Who may reach what is each network's access.
import { Tabs } from "@mantine/core";
import { useNavigate, useParams } from "react-router";
import { SectionNav } from "../../kit/layout";
import { PortForwardsPage } from "./PortForwardsPage";
import { RulesPage } from "./RulesPage";

const tabs = [
  { value: "port-forwards", label: "Port forwards", path: "/firewall" },
  { value: "rules", label: "Rules", path: "/firewall/rules" },
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
  const rules = first === "rules";
  // /firewall/<n> is a port forward; /firewall/rules/<n> a rule.
  const page = rules ? (
    <RulesPage sub={rest.join("/")} />
  ) : (
    <PortForwardsPage sub={[first, ...rest].filter(Boolean).join("/")} />
  );
  return (
    <SectionNav.Provider value={<FirewallTabs tab={rules ? "rules" : "port-forwards"} />}>
      {page}
    </SectionNav.Provider>
  );
};
