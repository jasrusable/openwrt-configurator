// Status › Internet: each connection, and the line as the router sees it now:
// latency (with what this tab has seen, as a small graph), the address the
// internet sees, DNS answering, smart queueing at work, and a speed test on
// request (test traffic for a few seconds).
import { Button, Group, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import type { Intent } from "../../../../src/intent/schema";
import { useNetworkStatus, useSpeedTest } from "../../data/status";
import { duration } from "../../facts";
import { useDraftValue } from "../../form/draft";
import { Section, SettingRow, SettingsPage, StatusDot } from "../../kit/layout";
import { bytes, liveLine, Muted } from "./shared";

/** The readings so far, as a line: lower is better. */
const Sparkline = ({ values }: { values: number[] }) => {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const points = values.map((v, i) => `${(i / (values.length - 1)) * 100},${28 - (v / max) * 26}`).join(" ");
  return (
    <svg width={100} height={30} viewBox="0 0 100 30" aria-hidden>
      <polyline points={points} fill="none" stroke="var(--mantine-color-blue-5)" strokeWidth={1.5} />
    </svg>
  );
};

export const InternetTab = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("internet");
  const speed = useSpeedTest();
  const check = status.data?.internetCheck;
  // Latency seen while this tab is open: kept here, never stored.
  const [latency, setLatency] = useState<number[]>([]);
  useEffect(() => {
    if (check?.latencyMs !== undefined) setLatency((seen) => [...seen.slice(-29), check.latencyMs!]);
  }, [status.dataUpdatedAt, check?.latencyMs]);
  return (
    <SettingsPage title="Internet" description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}>
      <Section title="Connections">
        {(status.data?.connections ?? []).map((c) => (
          <SettingRow
            key={c.id}
            label={c.name || c.id}
            description={[
              c.ipv4.join(", ") || undefined,
              c.ipv6.length ? `IPv6 ${c.ipv6[0]}` : undefined,
              c.line ? `${c.line.state} ${duration(c.line.since)}` : c.uptime !== undefined ? `up ${duration(c.uptime)}` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <Group gap={6} wrap="nowrap">
              {c.up !== undefined && <StatusDot color={c.up ? "green" : "red"} />}
              <Muted>{c.inUse ? "In use" : c.up ? "Ready" : c.up === false ? "Down" : "—"}</Muted>
            </Group>
          </SettingRow>
        ))}
      </Section>
      <Section title="From the router" description="Measured by the router itself, every 10 seconds while this tab is open.">
        <SettingRow label="Latency" description="To a public DNS server (1.1.1.1); lower is better.">
          <Group gap="sm" wrap="nowrap">
            <Sparkline values={latency} />
            <Muted>{check?.latencyMs !== undefined ? `${Math.round(check.latencyMs)} ms` : check ? "No answer" : "—"}</Muted>
          </Group>
        </SettingRow>
        <SettingRow label="Address on the internet" description="What websites see; another router may sit before yours.">
          <Muted>{check?.publicIpv4 ?? "—"}</Muted>
        </SettingRow>
        <SettingRow label="Name lookups (DNS)" description="The router answering for your devices.">
          <Group gap={6} wrap="nowrap">
            {check && <StatusDot color={check.dnsOk ? "green" : "red"} />}
            <Muted>{check ? (check.dnsOk ? "Working" : "Not answering") : "—"}</Muted>
          </Group>
        </SettingRow>
        {check?.queues.map((q) => (
          <SettingRow key={q.device} label={`Smart queueing on ${q.device}`} description="Packets it dropped to keep latency low while the line is busy.">
            <Muted>
              {q.dropped} dropped · {bytes(q.sentBytes)} sent
            </Muted>
          </SettingRow>
        ))}
        <SettingRow
          label="Speed"
          description={speed.isError ? (speed.error as Error).message : "Downloads test data for a few seconds, from the router."}
        >
          <Group gap="sm" wrap="nowrap">
            {speed.data && (
              <Text size="sm" fw={500}>
                {speed.data.downMbps} Mbit/s down
              </Text>
            )}
            <Button size="xs" variant="default" loading={speed.isPending} onClick={() => speed.mutate()}>
              {speed.data ? "Test again" : "Test speed"}
            </Button>
          </Group>
        </SettingRow>
      </Section>
    </SettingsPage>
  );
};
