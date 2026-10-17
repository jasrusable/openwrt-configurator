// VPN: remote access, linked sites and VPN providers, as tabs above each page's title.
import { useParams } from "react-router";
import { placeName } from "../../../../src/intent/places";
import { SectionNav } from "../../kit/layout";
import { SectionTabs } from "../../kit/SectionTabs";
import { ProvidersPage } from "./ProvidersPage";
import { RemoteAccessPage } from "./RemoteAccessPage";
import { SitesPage } from "./SitesPage";

const tabs = [
  { value: "remote", label: placeName("vpnRemote"), path: "/settings/vpn" },
  { value: "sites", label: placeName("vpnSites"), path: "/settings/vpn/sites" },
  { value: "providers", label: placeName("vpnProviders"), path: "/settings/vpn/providers" },
];

export const VpnPage = () => {
  const [first = "", ...rest] = (useParams()["*"] ?? "").split("/");
  // /vpn/<n> is a client; /vpn/sites/<n> a site; /vpn/providers/<n> a provider.
  const tab = first === "sites" || first === "providers" ? first : "remote";
  return (
    <SectionNav.Provider value={<SectionTabs tabs={tabs} tab={tab} />}>
      {tab === "sites" ? (
        <SitesPage sub={rest.join("/")} />
      ) : tab === "providers" ? (
        <ProvidersPage sub={rest.join("/")} />
      ) : (
        <RemoteAccessPage sub={[first, ...rest].filter(Boolean).join("/")} />
      )}
    </SectionNav.Provider>
  );
};
