// Activity: what happened, and when. Every event the collector told from
// one read to the next (src/status/events.ts): lines going down and coming
// back, failovers, devices lost and restarted, services, ports, Wi-Fi and
// mesh links, new clients, applies; by day, newest first, each opening what
// it is about. A device's own log is on its page.
import { Group, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { EventKind, NetworkEvent } from "../../../../src/status/events";
import { eventTone, useAllEvents, useNetworkStatus } from "../../data/status";
import { EmptyState } from "../../kit/layout";
import { Panel, StatusPage, ToneDot } from "../../kit/status";
import { liveLine, subjectLink, unread } from "./shared";

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/** The filter's choices: what each shows. */
const shows: Record<string, { label: string; kinds?: EventKind[]; problems?: true }> = {
  all: { label: "Everything" },
  problems: { label: "Problems", problems: true },
  internet: { label: "Internet", kinds: ["line", "failover"] },
  devices: { label: "Devices", kinds: ["device", "reboot", "service", "port"] },
  wifi: { label: "Wi-Fi", kinds: ["radio", "mesh"] },
  clients: { label: "Clients", kinds: ["client"] },
  applies: { label: "Applies", kinds: ["apply"] },
};

export const ActivityPage = () => {
  const navigate = useNavigate();
  const status = useNetworkStatus();
  const kept = useAllEvents();
  const [which, setWhich] = useState("all");
  const [device, setDevice] = useState<string | null>(null);
  // Every event kept, once read; the snapshot's latest until then.
  const all: NetworkEvent[] = kept.data ?? status.data?.events ?? [];
  const show = shows[which];
  const events = all.filter(
    (e) => (!device || e.device === device) && (!show.kinds || show.kinds.includes(e.kind)) && (!show.problems || e.severity === "problem" || e.severity === "warning")
  );
  const days = [...new Set(events.map((e) => day(e.at)))];
  const oldest = all[all.length - 1]?.at;
  return (
    <StatusPage title="Activity" live={liveLine(status)}>
      <Group gap="sm" wrap="wrap">
        <SegmentedControl size="xs" value={which} onChange={setWhich} data={Object.entries(shows).map(([value, { label }]) => ({ value, label }))} />
        <Select size="xs" placeholder="Every device" clearable data={[...new Set(all.flatMap((e) => (e.device ? [e.device] : [])))].sort()} value={device} onChange={setDevice} w={180} />
      </Group>
      {events.length === 0 && (
        <Panel>
          <EmptyState>{status.data ? (all.length ? "Nothing of this kind." : "Nothing has happened since the app started watching.") : unread(status, "Reading…")}</EmptyState>
        </Panel>
      )}
      {days.map((d) => (
        <Panel key={d} title={d} padded={false}>
          {events
            .filter((e) => day(e.at) === d)
            .map((e, i) => (
              <button key={`${e.at}-${e.subject}-${i}`} type="button" className="onc-list-row" onClick={() => navigate(subjectLink(e))}>
                <Text size="xs" c="dimmed" w={68} style={{ flexShrink: 0, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                  {time(e.at)}
                </Text>
                <ToneDot tone={eventTone(e)} label={e.severity} />
                <Text size="sm" style={{ flex: 1, minWidth: 0 }}>
                  {e.text}
                </Text>
                {e.device && (
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    {e.device}
                  </Text>
                )}
              </button>
            ))}
        </Panel>
      ))}
      {oldest !== undefined && (
        <Stack gap={0} px={4}>
          <Text size="xs" c="dimmed">
            Kept for 30 days. The earliest here is from {day(oldest)}; what happened while the app was not running is told where a device keeps a time for it (a line's or a device's uptime).
          </Text>
        </Stack>
      )}
    </StatusPage>
  );
};
