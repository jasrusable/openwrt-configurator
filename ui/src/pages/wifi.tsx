// Wi-Fi: the SSIDs, and each band's radios, as tabs above each page's title.
import { useParams } from "react-router";
import { SectionNav } from "../kit/layout";
import { SectionTabs } from "../kit/SectionTabs";
import { RadiosPage } from "./RadiosPage";
import { WifiPage } from "./WifiPage";

const tabs = [
  { value: "ssids", label: "SSIDs", path: "/wifi" },
  { value: "radios", label: "Radios", path: "/wifi/radios" },
];

export const WifiSection = () => {
  const [first = "", ...rest] = (useParams()["*"] ?? "").split("/");
  const radios = first === "radios";
  // /wifi/<n> is an SSID; /wifi/radios/<band> a band.
  return (
    <SectionNav.Provider value={<SectionTabs tabs={tabs} tab={radios ? "radios" : "ssids"} />}>
      {radios ? (
        <RadiosPage sub={rest.join("/")} />
      ) : (
        <WifiPage sub={[first, ...rest].filter(Boolean).join("/")} />
      )}
    </SectionNav.Provider>
  );
};
