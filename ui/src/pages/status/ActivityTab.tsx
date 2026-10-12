// Status › Activity: what happened lately on each device, in words: lines
// and networks going up and down, ports connecting, restarts, this app's own
// marks. Read from the devices' logs while this tab is open; nothing kept.
import { Group, Text } from "@mantine/core";
import type { Intent } from "../../../../src/intent/schema";
import { useNetworkStatus } from "../../data/status";
import { useDraftValue } from "../../form/draft";
import { EmptyState, Section, SettingRow, SettingsPage } from "../../kit/layout";
import { liveLine } from "./shared";

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export const ActivityTab = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("activity");
  const events = status.data?.activity ?? [];
  const days = [...new Set(events.map((e) => day(e.at)))];
  return (
    <SettingsPage title="Activity" description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}>
      {events.length === 0 && (
        <Section>
          <EmptyState>{status.data ? "Nothing worth telling lately." : "Reading the devices' logs…"}</EmptyState>
        </Section>
      )}
      {days.map((d) => (
        <Section key={d} title={d}>
          {events
            .filter((e) => day(e.at) === d)
            .map((e, i) => (
              <SettingRow
                key={`${e.at}-${e.device}-${i}`}
                label={
                  <Group gap={10} wrap="nowrap">
                    <Text size="sm" c="dimmed" w={44}>
                      {time(e.at)}
                    </Text>
                    {e.text}
                  </Group>
                }
              >
                <Text size="xs" c="dimmed">
                  {e.device}
                </Text>
              </SettingRow>
            ))}
        </Section>
      ))}
    </SettingsPage>
  );
};
