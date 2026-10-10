// The firewall section: its own pages, by the first part of the URL after
// /firewall; the rest goes to the list pages (a zone, a rule).
import { useParams } from "react-router";
import { FirewallOverviewPage } from "./OverviewPage";
import { PortForwardsPage } from "./PortForwardsPage";
import { RulesPage } from "./RulesPage";
import { FirewallSettingsPage } from "./SettingsPage";
import { ZonesPage } from "./ZonesPage";

export const firewallPages = [
  { id: "", label: "Overview" },
  { id: "zones", label: "Zones" },
  { id: "rules", label: "Rules" },
  { id: "port-forwards", label: "Port forwarding" },
  { id: "settings", label: "Settings" },
] as const;

export const FirewallPage = () => {
  const [section = "", ...rest] = (useParams()["*"] ?? "").split("/");
  const sub = rest.join("/");
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
