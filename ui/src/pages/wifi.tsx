// Wi-Fi: the SSIDs, each band's radios, and roaming, as tabs above each page's title.
import { useParams } from "react-router";
import { placeName } from "../../../src/intent/places";
import { SectionNav } from "../kit/layout";
import { SectionTabs } from "../kit/SectionTabs";
import { RadiosPage } from "./RadiosPage";
import { RoamingPage } from "./RoamingPage";
import { WifiPage } from "./WifiPage";

const tabs = [
  { value: "ssids", label: placeName("ssids"), path: "/wifi" },
  { value: "radios", label: placeName("radios"), path: "/wifi/radios" },
  { value: "roaming", label: placeName("roaming"), path: "/wifi/roaming" },
];

export const WifiSection = () => {
  const [first = "", ...rest] = (useParams()["*"] ?? "").split("/");
  // /wifi/<n> is an SSID; /wifi/radios/<band> a band; /wifi/roaming roaming.
  const tab = first === "radios" || first === "roaming" ? first : "ssids";
  return (
    <SectionNav.Provider value={<SectionTabs tabs={tabs} tab={tab} />}>
      {tab === "radios" ? (
        <RadiosPage sub={rest.join("/")} />
      ) : tab === "roaming" ? (
        <RoamingPage />
      ) : (
        <WifiPage sub={[first, ...rest].filter(Boolean).join("/")} />
      )}
    </SectionNav.Provider>
  );
};
