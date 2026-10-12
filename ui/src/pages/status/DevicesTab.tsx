// Status › Devices: each router and access point's health (uptime, load,
// memory, storage, temperature), its ports' links, and whether a newer
// OpenWrt release is out.
import { Badge, Group, Text } from "@mantine/core";
import type { Intent } from "../../../../src/intent/schema";
import type { DeviceView } from "../../../../src/status/views";
import { compareReleases } from "../../../../src/release";
import { useLatestRelease, useNetworkStatus } from "../../data/status";
import { duration } from "../../facts";
import { useDraftValue } from "../../form/draft";
import { Section, SettingRow, SettingsPage, StatusDot } from "../../kit/layout";
import { liveLine, Muted } from "./shared";

const percent = (share: number) => `${Math.round(share * 100)}%`;

const Ports = ({ device }: { device: DeviceView }) =>
  device.ports.length === 0 ? (
    <Muted>—</Muted>
  ) : (
    <Group gap={6} justify="flex-end">
      {device.ports.map((p) => (
        <Badge
          key={p.name}
          variant="light"
          color={p.up ? "green" : "gray"}
          radius="sm"
          leftSection={<StatusDot color={p.up ? "green" : "gray"} />}
          style={{ textTransform: "none" }}
        >
          {p.name}
          {p.up ? (p.speed ? ` · ${p.speed >= 1000 ? `${p.speed / 1000} Gbit/s` : `${p.speed} Mbit/s`}` : " · up") : ""}
        </Badge>
      ))}
    </Group>
  );

export const DevicesTab = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("devices");
  const latest = useLatestRelease().data?.version;
  return (
    <SettingsPage title="Devices" description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}>
      {(status.data?.deviceViews ?? []).map((d) => {
        const behind = !!latest && !!d.version && (compareReleases(d.version, latest) ?? 0) < 0;
        return (
          <Section key={d.name} title={d.name}>
            <SettingRow
              label={d.model ?? (d.role === "router" ? "Router" : "Access point")}
              description={d.version ? `OpenWrt ${d.version}${behind ? `: ${latest} is out` : ""}` : undefined}
            >
              <Group gap={6} wrap="nowrap">
                <StatusDot color={d.reachable ? "green" : "red"} />
                <Muted>{d.reachable ? `Up ${duration(d.uptime ?? 0)}` : "Not reached"}</Muted>
              </Group>
            </SettingRow>
            {d.reachable ? (
              <>
                <SettingRow label="Load" description="Work waiting for the processor, averaged over a minute.">
                  <Muted>{d.load?.toFixed(2)}</Muted>
                </SettingRow>
                <SettingRow label="Memory in use">
                  <Muted>{percent(d.memoryUsed ?? 0)}</Muted>
                </SettingRow>
                {d.storage && (
                  <SettingRow label="Storage free" description="For settings and packages.">
                    <Muted>
                      {Math.round(d.storage.availableKb / 1024)} of {Math.round(d.storage.totalKb / 1024)} MiB
                    </Muted>
                  </SettingRow>
                )}
                {d.temperature !== undefined && (
                  <SettingRow label="Temperature">
                    <Muted>{d.temperature} °C</Muted>
                  </SettingRow>
                )}
                <SettingRow label="Ports">
                  <Ports device={d} />
                </SettingRow>
              </>
            ) : (
              <SettingRow label="Why" description={d.error} />
            )}
          </Section>
        );
      })}
      {latest && (
        <Text size="xs" c="dimmed" px={4}>
          OpenWrt's latest release: {latest}.
        </Text>
      )}
    </SettingsPage>
  );
};
