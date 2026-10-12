// Tabs above every page of a sidebar section (Wi-Fi: SSIDs and Radios), so
// its pages, and the items nested in them, share them. Give it to the
// section's pages through SectionNav.
import { Tabs } from "@mantine/core";
import { useNavigate } from "react-router";

export type SectionTab = { value: string; label: string; path: string };

export const SectionTabs = ({ tabs, tab }: { tabs: SectionTab[]; tab: string }) => {
  const navigate = useNavigate();
  return (
    <Tabs
      value={tab}
      onChange={(value) => navigate(tabs.find((t) => t.value === value)?.path ?? tabs[0].path)}
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
