// Devices: are the routers and access points healthy? Each as a row: what
// it is and runs, whether it answers and since when, its processor, memory
// and temperature, its clients and how it reaches the router. A row opens
// its own page (DevicePage); its settings are Settings › Hardware.
import { Group, Stack, Text } from "@mantine/core";
import { useNavigate, useParams } from "react-router";
import { where } from "../../../../src/intent/places";
import type { Intent } from "../../../../src/intent/schema";
import { tone as toneOf } from "../../../../src/status/health";
import type { DeviceView } from "../../../../src/status/views";
import { useUpdates } from "../../data/firmware";
import { useNetworkStatus } from "../../data/status";
import { useDraftValue } from "../../form/draft";
import { UpdateDot } from "../../kit/UpdateDot";
import { Panel, percent, StatusPage, ToneValue, Verdict } from "../../kit/status";
import { StatusColumn, StatusTable } from "../../kit/StatusTable";
import { DevicePage } from "./DevicePage";
import { deviceState, liveLine, roleIcon, ThingIcon, unread, uplinkWords } from "./shared";

const DeviceList = () => {
  const navigate = useNavigate();
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus();
  const updates = useUpdates();
  const live = status.data;
  const views = live?.deviceViews ?? [];
  const clientsOn = (name: string) => (live?.clientList ?? []).filter((c) => c.state === "online" && c.connection.kind === "wifi" && c.connection.accessPoint === name).length;
  const hasRadios = (name: string) => (live?.radios ?? []).some((r) => r.accessPoint === name);
  const perCore = (d: DeviceView) => (d.load !== undefined ? d.load / (d.cores ?? 1) : undefined);
  const down = views.filter((d) => !d.reachable && !d.rebooting);
  const warned = (live?.attention ?? []).filter((a) => /^(storage|temperature|memory|service|unread):/.test(a.id));
  const columns: StatusColumn<DeviceView>[] = [
    {
      key: "name",
      header: "Name",
      sort: (d) => d.name.toLowerCase(),
      cell: (d) => (
        <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
          <ThingIcon icon={roleIcon(d.role)} away={!d.reachable} />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} truncate>
              {d.name}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {d.model ?? (d.role === "router" ? "Router" : "Access point")}
            </Text>
          </Stack>
        </Group>
      ),
    },
    {
      key: "release",
      header: "OpenWrt",
      sort: (d) => d.version,
      cell: (d) => (
        <Group gap={6} wrap="nowrap">
          <Text size="sm">{d.version ?? "—"}</Text>
          {updates?.devices.includes(d.name) && <UpdateDot label={`OpenWrt ${updates.version} is out`} />}
        </Group>
      ),
    },
    {
      key: "state",
      header: "State",
      sort: (d) => (d.reachable ? (d.uptime ?? 0) : -1),
      cell: (d) => <ToneValue tone={deviceState(d).tone}>{deviceState(d).word}</ToneValue>,
    },
    { key: "load", header: "Processor", align: "right", sort: perCore, cell: (d) => <ToneValue tone={toneOf.load(perCore(d))}>{perCore(d) !== undefined ? percent(perCore(d)) : "—"}</ToneValue> },
    { key: "memory", header: "Memory", align: "right", sort: (d) => d.memoryUsed, cell: (d) => <ToneValue tone={toneOf.memory(d.memoryUsed)}>{percent(d.memoryUsed)}</ToneValue> },
    {
      key: "temperature",
      header: "Temp.",
      align: "right",
      sort: (d) => d.temperature,
      cell: (d) => <ToneValue tone={toneOf.temperature(d.temperature)}>{d.temperature !== undefined ? `${Math.round(d.temperature)} °C` : "—"}</ToneValue>,
    },
    {
      key: "clients",
      header: "Clients",
      align: "right",
      sort: (d) => clientsOn(d.name),
      // On its Wi-Fi: a device without radios has none to count.
      cell: (d) => <Text size="sm">{d.reachable && hasRadios(d.name) ? clientsOn(d.name) : "—"}</Text>,
    },
    {
      key: "uplink",
      header: "Uplink",
      sort: (d) => uplinkWords(intent, live, d.name).word,
      cell: (d) => {
        const u = uplinkWords(intent, live, d.name);
        return <ToneValue tone={u.tone}>{u.word}</ToneValue>;
      },
    },
  ];
  return (
    <StatusPage title="Devices" live={liveLine(status)}>
      <Verdict
        tone={!live ? "off" : down.length ? "poor" : warned.length ? "fair" : "good"}
        detail={live && [warned.map((a) => a.title).join(" · ") || undefined, updates ? `OpenWrt ${updates.version} is out for ${updates.devices.join(", ")}` : undefined].filter(Boolean).join(" · ")}
      >
        {!live ? "Reading the devices…" : down.length ? `${down.map((d) => d.name).join(", ")} not answering` : `${views.length} of ${views.length} up`}
      </Verdict>
      <Panel padded={false}>
        <StatusTable
          id="devices"
          rows={views}
          columns={columns}
          rowKey={(d) => d.name}
          onOpen={(d) => navigate(`/devices/${encodeURIComponent(d.name)}`)}
          empty={live ? `No devices yet: add them in the ${where("hardware")} settings.` : unread(status, "Reading the devices…")}
          phone={(d) => ({
            lead: (
              <Text size="sm" fw={500}>
                {d.name}
              </Text>
            ),
            sub: [d.model, d.version && `OpenWrt ${d.version}`, uplinkWords(intent, live, d.name).word].filter(Boolean).join(" · "),
            end: <ToneValue tone={deviceState(d).tone}>{deviceState(d).word}</ToneValue>,
          })}
        />
      </Panel>
    </StatusPage>
  );
};

export const DevicesPage = () => {
  const name = useParams()["*"];
  return name ? <DevicePage name={decodeURIComponent(name)} /> : <DeviceList />;
};
