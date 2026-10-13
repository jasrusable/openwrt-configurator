// Devices: each router and access point's health (processor, memory,
// storage, temperature, with their history), its ports' links as a
// faceplate, whether a newer OpenWrt release is out, and what can be done to
// it (ping from it, restart its Wi-Fi, reboot it: DeviceActions).
import { Badge, Box, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { IconAccessPoint, IconRouter } from "@tabler/icons-react";
import type { Intent } from "../../../../src/intent/schema";
import type { DeviceView } from "../../../../src/status/views";
import { compareReleases } from "../../../../src/release";
import { targetOf } from "../../../../src/firmware/target";
import { useSeries } from "../../data/history";
import { useReleases } from "../../data/firmware";
import { useNetworkStatus } from "../../data/status";
import { duration } from "../../facts";
import { useDraftValue } from "../../form/draft";
import { AreaChart, PortFace, Ring } from "../../kit/charts";
import { EmptyState, ItemIcon, Section, SettingsPage, StatusDot } from "../../kit/layout";
import { DeviceActions } from "./DeviceActions";
import { liveLine, unread } from "./shared";

const heat = (c: number) => (c >= 85 ? "red" : c >= 70 ? "orange" : c >= 55 ? "yellow" : "teal");

/** The release a device should run (System › Firmware), when it runs an older one. */
const useUpdate = (device: DeviceView) => {
  const intent: Intent = useDraftValue();
  const target = targetOf(intent, device.name, useReleases().data?.releases);
  return target.kind === "release" && !!device.version && (compareReleases(device.version, target.version) ?? 0) < 0
    ? target.version
    : undefined;
};

const DeviceCard = ({ device: d }: { device: DeviceView }) => {
  const load = useSeries(`load:${d.name}`);
  const temperature = useSeries(`temperature:${d.name}`);
  const update = useUpdate(d);
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
            {update && (
              <Badge variant="light" color="blue" radius="sm" style={{ textTransform: "none" }}>
                {update} is out
              </Badge>
            )}
            <StatusDot color={d.rebooting ? "orange" : d.reachable ? "green" : "red"} />
            <Text size="sm" c="dimmed" style={{ whiteSpace: "nowrap" }}>
              {d.rebooting ? "Rebooting…" : d.reachable ? (d.uptime ? `Up ${duration(d.uptime)}` : "Up") : "Not reached"}
            </Text>
            <DeviceActions device={d} />
          </Group>
        </Group>
        {d.reachable && !d.rebooting ? (
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
            {d.rebooting ? "It is restarting: back in a minute or so." : (d.error ?? "It did not answer.")}
          </Text>
        )}
      </Stack>
    </Box>
  );
};

export const DevicesPage = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus();
  const devices = status.data?.deviceViews ?? [];
  return (
    <SettingsPage title="Devices" description={liveLine(intent.system.name, status)}>
      {devices.length === 0 && (
        <Section>
          <EmptyState>{status.data ? "No devices in Hardware." : unread(status, "Reading the devices…")}</EmptyState>
        </Section>
      )}
      {devices.map((d) => (
        <DeviceCard key={d.name} device={d} />
      ))}
    </SettingsPage>
  );
};
