// The firewall section: its own pages, by the first part of the URL after
// /firewall, as tabs above each page's title; the rest of the URL goes to
// the list pages (a zone, a rule).
import { Tabs } from "@mantine/core";
import { useNavigate, useParams } from "react-router";
import { SectionNav } from "../../kit/layout";
import { FirewallOverviewPage } from "./OverviewPage";
import { PortForwardsPage } from "./PortForwardsPage";
import { RulesPage } from "./RulesPage";
import { FirewallSettingsPage } from "./SettingsPage";
import { ZonesPage } from "./ZonesPage";

export const firewallPages = [
  // At /firewall itself.
  { id: "overview", label: "Overview" },
  { id: "zones", label: "Zones" },
  { id: "rules", label: "Rules" },
  { id: "port-forwards", label: "Port forwarding" },
  { id: "settings", label: "Settings" },
] as const;

const FirewallTabs = ({ section }: { section: string }) => {
  const navigate = useNavigate();
  return (
    <Tabs
      value={section}
      onChange={(value) =>
        navigate(value && value !== "overview" ? `/firewall/${value}` : "/firewall")
      }
    >
      <Tabs.List>
        {firewallPages.map((page) => (
          <Tabs.Tab key={page.id} value={page.id}>
            {page.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
    </Tabs>
  );
};

export const FirewallPage = () => {
  const [first = "", ...rest] = (useParams()["*"] ?? "").split("/");
  const section = firewallPages.some((p) => p.id === first) ? first : "overview";
  return (
    <SectionNav.Provider value={<FirewallTabs section={section} />}>
      <FirewallSection section={section} sub={rest.join("/")} />
    </SectionNav.Provider>
  );
};

const FirewallSection = ({ section, sub }: { section: string; sub: string }) => {
  switch (section) {
    case "zones":
      return <ZonesPage sub={sub} />;
    case "rules":
      return <RulesPage sub={sub} />;
    case "port-forwards":
      return <PortForwardsPage sub={sub} />;
    case "settings":
      return <FirewallSettingsPage />;
    default:
      return <FirewallOverviewPage />;
  }
};
