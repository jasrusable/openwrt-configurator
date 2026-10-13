// System: name, time and login, and the patches over OpenWrt, as tabs above each page's title.
import { useParams } from "react-router";
import { placeName } from "../../../src/intent/places";
import { SectionNav } from "../kit/layout";
import { SectionTabs } from "../kit/SectionTabs";
import { FixesPage } from "./FixesPage";
import { SystemPage } from "./SystemPage";

const tabs = [
  { value: "general", label: placeName("general"), path: "/system" },
  { value: "patches", label: placeName("patches"), path: "/system/patches" },
];

export const SystemSection = () => {
  const [first = ""] = (useParams()["*"] ?? "").split("/");
  const patches = first === "patches";
  return (
    <SectionNav.Provider value={<SectionTabs tabs={tabs} tab={patches ? "patches" : "general"} />}>
      {patches ? <FixesPage /> : <SystemPage />}
    </SectionNav.Provider>
  );
};
