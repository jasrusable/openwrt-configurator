// The firewall's own settings, as tabs above each page's title: port
// forwards and rules. Who may reach what is each network's access.
import { useParams } from "react-router";
import { placeName } from "../../../../src/intent/places";
import { SectionNav } from "../../kit/layout";
import { SectionTabs } from "../../kit/SectionTabs";
import { PortForwardsPage } from "./PortForwardsPage";
import { RulesPage } from "./RulesPage";

const tabs = [
  { value: "port-forwards", label: placeName("portForwards"), path: "/settings/firewall" },
  { value: "rules", label: placeName("rules"), path: "/settings/firewall/rules" },
];

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
    <SectionNav.Provider value={<SectionTabs tabs={tabs} tab={rules ? "rules" : "port-forwards"} />}>
      {page}
    </SectionNav.Provider>
  );
};
