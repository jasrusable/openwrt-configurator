// System: name, time and login, the patches over OpenWrt, firmware, and backups, as tabs above each page's title.
import { useParams } from "react-router";
import { placeName } from "../../../src/intent/places";
import { SectionNav } from "../kit/layout";
import { SectionTabs } from "../kit/SectionTabs";
import { UpdateDot } from "../kit/UpdateDot";
import { useUpdates } from "../data/firmware";
import { BackupPage } from "./BackupPage";
import { FirmwarePage } from "./FirmwarePage";
import { FixesPage } from "./FixesPage";
import { SystemPage } from "./SystemPage";

/** Each tab: its place, its page, and its path (the first is /system itself). */
const sections = [
  { value: "general", Page: SystemPage },
  { value: "patches", Page: FixesPage },
  { value: "firmware", Page: FirmwarePage },
  { value: "backup", Page: BackupPage },
] as const;

const tabs = sections.map(({ value }, i) => ({ value, label: placeName(value), path: i === 0 ? "/system" : `/system/${value}` }));

export const SystemSection = () => {
  const [first = ""] = (useParams()["*"] ?? "").split("/");
  const updates = useUpdates();
  const marked = tabs.map((t) => (t.value === "firmware" && updates ? { ...t, mark: <UpdateDot label={updates.text} /> } : t));
  const { value, Page } = sections.find((s) => s.value === first) ?? sections[0];
  return (
    <SectionNav.Provider value={<SectionTabs tabs={marked} tab={value} />}>
      <Page />
    </SectionNav.Provider>
  );
};
