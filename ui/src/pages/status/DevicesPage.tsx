// Devices: each router and access point's health (processor, memory,
// storage, temperature, with this browser's history of them), its ports'
// links as a faceplate, and whether a newer OpenWrt release is out.
import { Badge, Box, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { IconAccessPoint, IconRouter } from "@tabler/icons-react";
import type { Intent } from "../../../../src/intent/schema";
import type { DeviceView } from "../../../../src/status/views";
import { compareReleases } from "../../../../src/release";
import { useSeries } from "../../data/history";
import { useLatestRelease, useNetworkStatus } from "../../data/status";
import { duration } from "../../facts";
import { useDraftValue } from "../../form/draft";
import { AreaChart, PortFace, Ring } from "../../kit/charts";
import { EmptyState, ItemIcon, Section, SettingsPage, StatusDot } from "../../kit/layout";
import { liveLine } from "./shared";

const heat = (c: number) => (c >= 85 ? "red" : c >= 70 ? "orange" : c >= 55 ? "yellow" : "teal");

const DeviceCard = ({ device: d, latest }: { device: DeviceView; latest?: string }) => {
  const load = useSeries(`load:${d.name}`);
  const temperature = useSeries(`temperature:${d.name}`);
  const behind = !!latest && !!d.version && (compareReleases(d.version, latest) ?? 0) < 0;
  const cpu = d.load !== undefined ? d.load / (d.cores ?? 1) : undefined;
  return (
    <Box className="onc-card" p="md">
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
            <ItemIcon icon={d.role === "router" ? IconRouter : IconAccessPoint} color="grape" off={!d.reachable} />
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text fw={600} truncate>
                {d.name}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {[d.model ?? (d.role === "router" ? "Router" : "Access point"), d.version && `OpenWrt ${d.version}`].filter(Boolean).join(" · ")}
              </Text>
            </Stack>
          </Group>
          <Group gap={8} wrap="nowrap">
            {behind && (
              <Badge variant="light" color="blue" radius="sm" style={{ textTransform: "none" }}>
                {latest} is out
              </Badge>
            )}
            <StatusDot color={d.reachable ? "green" : "red"} />
            <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {d.reachable ? (d.uptime ? `Up ${duration(d.uptime)}` : "Up") : "Not reached"}
            </Text>
          </Group>
        </Group>
        {d.reachable ? (
          <>
            <Group justify="space-around" wrap="wrap" gap="md">
              {cpu !== undefined && <Ring share={Math.min(cpu, 1)} label={`Processor${d.cores ? ` · ${d.cores} cores` : ""}`} />}
              {d.memoryUsed !== undefined && <Ring share={d.memoryUsed} label="Memory" />}
              {d.storage && d.storage.totalKb > 0 && <Ring share={1 - d.storage.availableKb / d.storage.totalKb} label={`Storage · ${Math.round(d.storage.availableKb / 1024)} MiB free`} />}
              {d.temperature !== undefined && (
                <Stack gap={2} align="center" justify="center" h={100}>
                  <Text fz={28} fw={600} c={`${heat(d.temperature)}.6`} lh={1}>
                    {Math.round(d.temperature)}°
                  </Text>
                  <Text size="xs" c="dimmed">
                    Temperature
                  </Text>
                </Stack>
              )}
            </Group>
            <SimpleGrid cols={temperature.length ? 2 : 1} spacing="md">
              <Stack gap={2}>
                <Text size="xs" c="dimmed">
                  Processor load
                </Text>
                <AreaChart series={[load]} colors={["grape"]} height={44} max={1} />
              </Stack>
              {temperature.length > 0 && (
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Temperature
                  </Text>
                  <AreaChart series={[temperature]} colors={["orange"]} height={44} min={20} max={100} />
                </Stack>
              )}
            </SimpleGrid>
            {d.ports.length > 0 && <PortFace ports={d.ports} />}
          </>
        ) : (
          <Text size="sm" c="dimmed">
            {d.error ?? "It did not answer."}
          </Text>
        )}
      </Stack>
    </Box>
  );
};

export const DevicesPage = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("devices");
  const latest = useLatestRelease().data?.version;
  const devices = status.data?.deviceViews ?? [];
  return (
    <SettingsPage title="Devices" description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}>
      {devices.length === 0 && (
        <Section>
          <EmptyState>{status.data ? "No devices in Hardware." : "Reading the devices…"}</EmptyState>
        </Section>
      )}
      {devices.map((d) => (
        <DeviceCard key={d.name} device={d} latest={latest} />
      ))}
      {latest && (
        <Text size="xs" c="dimmed" px={4}>
          OpenWrt's latest release: {latest}.
        </Text>
      )}
    </SettingsPage>
  );
};
