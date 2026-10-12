// Activity: what happened on each device, in words: lines and networks going
// up and down, ports connecting, restarts, applies from this app, its own
// marks. Read from the devices' logs while this page is open, and kept beside
// the settings, as logs roll over.
import { Group, SegmentedControl, Select, Text, ThemeIcon } from "@mantine/core";
import { IconAlertTriangle, IconArrowDown, IconArrowUp, IconCloudUpload, IconInfoCircle, IconPower } from "@tabler/icons-react";
import { useState } from "react";
import type { Intent } from "../../../../src/intent/schema";
import type { ActivityKind } from "../../../../src/status/views";
import { useNetworkStatus } from "../../data/status";
import { useDraftValue } from "../../form/draft";
import { EmptyState, Section, SettingRow, SettingsPage } from "../../kit/layout";
import { liveLine } from "./shared";

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

const look: Record<ActivityKind, [typeof IconInfoCircle, string]> = {
  up: [IconArrowUp, "green"],
  down: [IconArrowDown, "orange"],
  start: [IconPower, "blue"],
  apply: [IconCloudUpload, "violet"],
  problem: [IconAlertTriangle, "red"],
  note: [IconInfoCircle, "gray"],
};

/** The filter's choices: what each shows. */
const shows: Record<string, (k: ActivityKind) => boolean> = {
  all: () => true,
  problems: (k) => k === "down" || k === "problem",
  changes: (k) => k === "apply" || k === "start",
};

export const ActivityPage = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("activity");
  const [device, setDevice] = useState<string | null>(null);
  const [which, setWhich] = useState("all");
  const all = status.data?.activity ?? [];
  const events = all.filter((e) => (!device || e.device === device) && shows[which](e.kind ?? "note"));
  const days = [...new Set(events.map((e) => day(e.at)))];
  return (
    <SettingsPage title="Activity" description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}>
      <Group gap="sm">
        <SegmentedControl
          size="xs"
          value={which}
          onChange={setWhich}
          data={[
            { value: "all", label: "Everything" },
            { value: "problems", label: "Problems" },
            { value: "changes", label: "Applies and restarts" },
          ]}
        />
        <Select size="xs" placeholder="Every device" clearable data={[...new Set(all.map((e) => e.device))]} value={device} onChange={setDevice} w={180} />
      </Group>
      {events.length === 0 && (
        <Section>
          <EmptyState>{status.data ? "Nothing to tell here." : "Reading the devices' logs…"}</EmptyState>
        </Section>
      )}
      {days.map((d) => (
        <Section key={d} title={d}>
          {events
            .filter((e) => day(e.at) === d)
            .map((e, i) => {
              const [Icon, color] = look[e.kind ?? "note"];
              return (
                <SettingRow
                  key={`${e.at}-${e.device}-${i}`}
                  label={
                    <Group gap={10} wrap="nowrap">
                      <Text size="xs" c="dimmed" w={60} style={{ whiteSpace: "nowrap" }}>
                        {time(e.at)}
                      </Text>
                      <ThemeIcon variant="light" color={color} radius="xl" size={22}>
                        <Icon size={13} />
                      </ThemeIcon>
                      {e.text}
                    </Group>
                  }
                >
                  <Text size="xs" c="dimmed">
                    {e.device}
                  </Text>
                </SettingRow>
              );
            })}
        </Section>
      ))}
    </SettingsPage>
  );
};
