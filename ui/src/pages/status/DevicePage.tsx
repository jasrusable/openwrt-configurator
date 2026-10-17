// One router or access point: whether it is well (its verdict, and what
// needs you about it), its health over time, its ports, radios and mesh
// links, who is on it, the services your settings need there, its release,
// what it runs that your settings do not have, what happened to it, and its
// log. What can be done to it is in its menu (DeviceActions); its settings
// are one click away, in Settings › Hardware.
import { Anchor, Button, Group, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { useNavigate } from "react-router";
import { meshMtu } from "../../../../src/intent/mesh";
import { where } from "../../../../src/intent/places";
import type { Intent } from "../../../../src/intent/schema";
import { releaseNotesUrl } from "../../../../src/firmware/target";
import { thresholds, tone as toneOf, Tone, worst } from "../../../../src/status/health";
import { peerState } from "../../../../src/status/views";
import { useUpdates } from "../../data/firmware";
import { useRangeSwitch, useSeries } from "../../data/history";
import { useMeasureLink } from "../../data/mesh";
import { eventTone, useNetworkStatus, useRestartService } from "../../data/status";
import { duration } from "../../facts";
import { useDraftValue } from "../../form/draft";
import { PortFace } from "../../kit/charts";
import { dbm, Facts, Panel, percent, StatusPage, ToneDot, ToneValue, Verdict } from "../../kit/status";
import { TimeChart } from "../../kit/TimeChart";
import { DeviceActions } from "./DeviceActions";
import { AttentionRows, clientName, deviceState, RangeSwitch, eventsAbout, eventTime, kindIcon, liveLine, modeWords, ThingIcon, uplinkWords } from "./shared";

/** A mesh link and its speed measured on request (sends test traffic for a few seconds). */
const MeshLink = ({ from, to, throughput }: { from: string; to: string; throughput: number }) => {
  const measure = useMeasureLink();
  return (
    <Group justify="space-between" px="md" py={8} wrap="nowrap" className="onc-list-row" style={{ cursor: "default" }}>
      <Text size="sm">{to}</Text>
      <Group gap="md" wrap="nowrap">
        <ToneValue tone={throughput < 20 ? "fair" : "good"} hint="batman-adv's estimate of the route's throughput">
          ~{Math.round(throughput)} Mbit/s
        </ToneValue>
        {measure.data ? (
          <Text size="sm" fw={500}>
            {Math.round(measure.data.mbps)} Mbit/s measured
          </Text>
        ) : (
          <Button size="compact-xs" variant="default" loading={measure.isPending} onClick={() => measure.mutate({ from, to })}>
            Measure
          </Button>
        )}
      </Group>
      {measure.isError && (
        <Text size="xs" c="red">
          {(measure.error as Error).message}
        </Text>
      )}
    </Group>
  );
};

const ServiceRow = ({ device, service }: { device: string; service: { name: string; running: boolean; missing?: boolean } }) => {
  const restart = useRestartService();
  return (
    <Group justify="space-between" px="md" py={8} wrap="nowrap" className="onc-list-row" style={{ cursor: "default" }}>
      <Text size="sm" ff="monospace" fz={13}>
        {service.name}
      </Text>
      <Group gap="sm" wrap="nowrap">
        <ToneValue tone={service.running ? "good" : "poor"}>{service.running ? "Running" : service.missing ? "Not installed" : "Stopped"}</ToneValue>
        {!service.running && !service.missing && (
          <Button size="compact-xs" variant="default" loading={restart.isPending} disabled={restart.isSuccess} onClick={() => restart.mutate({ device, service: service.name })}>
            {restart.isSuccess ? "Restarted" : "Restart"}
          </Button>
        )}
      </Group>
    </Group>
  );
};

export const DevicePage = ({ name }: { name: string }) => {
  const navigate = useNavigate();
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus();
  const updates = useUpdates();
  const live = status.data;
  const index = intent.hardware.findIndex((d) => d.name === name);
  const device = live?.deviceViews?.find((d) => d.name === name);
  const load = useSeries(`load:${name}`);
  const memory = useSeries(`memory:${name}`);
  const temperature = useSeries(`temperature:${name}`);
  const range = useRangeSwitch().value;
  const crumbs = [{ label: "Devices", onClick: () => navigate("/devices") }, { label: name }];
  if (index < 0) {
    return (
      <StatusPage title={crumbs}>
        <Verdict tone="off">Not in your settings</Verdict>
        <Text size="sm" c="dimmed">
          There is no device named {name} in Settings › Hardware.
        </Text>
      </StatusPage>
    );
  }
  const role = intent.hardware[index].role;
  const state = deviceState(device);
  const attention = (live?.attention ?? []).filter((a) => a.id.split(":").includes(name) && !a.id.startsWith("unreachable:"));
  const radios = (live?.radios ?? []).filter((r) => r.accessPoint === name);
  const mesh = live?.mesh?.find((m) => m.name === name);
  const clients = (live?.clientList ?? []).filter((c) => c.state === "online" && c.connection.kind === "wifi" && c.connection.accessPoint === name);
  const perCore = device?.load !== undefined ? device.load / (device.cores ?? 1) : undefined;
  const uplink = uplinkWords(intent, live, name);
  const unexpected = [
    ...(role === "router" ? (live?.unexpected.interfaces ?? []).map((id) => ({ id, what: "An interface" })) : []),
    ...(live?.unexpected.ssids ?? []).filter((ssid) => radios.some((r) => r.ssid === ssid)).map((id) => ({ id, what: "An SSID it broadcasts" })),
  ];
  const events = eventsAbout(live?.events, `device:${name}`, `radio:${name}`, `mesh:${name}`, `service:${name}`, `port:${name}`);
  const update = updates?.devices.includes(name) ? updates.version : undefined;
  const health: Tone = worst(toneOf.load(perCore), toneOf.memory(device?.memoryUsed), toneOf.temperature(device?.temperature));
  const verdictTone: Tone = state.tone !== "good" ? state.tone : attention.some((a) => a.severity !== "info") ? "fair" : health === "poor" ? "fair" : "good";
  return (
    <StatusPage
      title={crumbs}
      live={liveLine(status)}
      actions={
        <>
          <Button size="xs" variant="default" onClick={() => navigate(`/settings/hardware/${index}`)}>
            Hardware settings
          </Button>
          {device && <DeviceActions device={device} />}
        </>
      }
    >
      <Stack gap="sm">
        <Verdict
          tone={live ? verdictTone : "off"}
          detail={[device?.model, device?.version && `OpenWrt ${device.version}`, role === "router" ? "Router" : "Access point"].filter(Boolean).join(" · ")}
        >
          {!live
            ? "Reading…"
            : !device?.reachable
              ? device?.rebooting
                ? "Restarting: back in a minute or so"
                : `Not answering${device?.error ? `: ${device.error}` : ""}`
              : [state.word, role !== "router" ? `${clients.length} on Wi-Fi` : undefined, role !== "router" ? uplink.word : undefined].filter(Boolean).join(" · ")}
        </Verdict>
        {attention.length > 0 && <AttentionRows items={attention} />}
      </Stack>
      {device?.reachable && (
        <>
          <Panel title="Health" actions={<RangeSwitch />}>
            <Stack gap="md">
              <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="md">
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Processor{device.cores ? `, ${device.cores} cores` : ""}
                  </Text>
                  <ToneValue tone={toneOf.load(perCore)}>{percent(perCore)}</ToneValue>
                </Stack>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Memory used
                  </Text>
                  <ToneValue tone={toneOf.memory(device.memoryUsed)}>{percent(device.memoryUsed)}</ToneValue>
                </Stack>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Temperature
                  </Text>
                  <ToneValue tone={toneOf.temperature(device.temperature)}>{device.temperature !== undefined ? `${Math.round(device.temperature)} °C` : "—"}</ToneValue>
                </Stack>
                <Stack gap={2}>
                  <Text size="xs" c="dimmed">
                    Storage free
                  </Text>
                  <ToneValue tone={device.storage ? (device.storage.availableKb / device.storage.totalKb < 0.1 ? "poor" : "good") : undefined}>
                    {device.storage ? `${Math.round(device.storage.availableKb / 1024)} MiB` : "—"}
                  </ToneValue>
                </Stack>
              </SimpleGrid>
              <SimpleGrid cols={{ base: 1, sm: temperature.length ? 3 : 2 }} spacing="md">
                <Stack gap={4}>
                  <Text size="xs" c="dimmed">
                    Processor, per core
                  </Text>
                  <TimeChart label="Processor" range={range} series={[{ label: "Processor", points: load }]} format={(v) => percent(v)} max={1} height={100} bands={[{ from: thresholds.load.good, to: thresholds.load.fair, tone: "fair" }, { from: thresholds.load.fair, tone: "poor" }]} />
                </Stack>
                <Stack gap={4}>
                  <Text size="xs" c="dimmed">
                    Memory used
                  </Text>
                  <TimeChart label="Memory" range={range} series={[{ label: "Memory", points: memory }]} format={(v) => percent(v)} max={1} height={100} />
                </Stack>
                {temperature.length > 0 && (
                  <Stack gap={4}>
                    <Text size="xs" c="dimmed">
                      Temperature
                    </Text>
                    <TimeChart label="Temperature" range={range} series={[{ label: "Temperature", points: temperature }]} format={(v) => `${Math.round(v)} °C`} min={20} max={90} height={100} bands={[{ from: thresholds.temperature.good, to: thresholds.temperature.fair, tone: "fair" }, { from: thresholds.temperature.fair, tone: "poor" }]} />
                  </Stack>
                )}
              </SimpleGrid>
            </Stack>
          </Panel>
          {device.ports.length > 0 && (
            <Panel title="Ports">
              <PortFace ports={device.ports} />
            </Panel>
          )}
        </>
      )}
      {radios.length > 0 && (
        <Panel title="Radios" padded={false}>
          <Table.ScrollContainer minWidth={560} type="native">
            <Table verticalSpacing={8} horizontalSpacing="md" withRowBorders={false}>
              <Table.Thead>
                <Table.Tr>
                  {["Network name", "Band", "Channel", "Busy", "Noise", "Power", "Clients"].map((h, i) => (
                    <Table.Th key={h} ta={i >= 3 ? "right" : undefined}>
                      <Text span size="xs" c="dimmed" fw={500}>
                        {h}
                      </Text>
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {radios.map((r) => (
                  <Table.Tr key={r.ifname}>
                    <Table.Td>
                      <Text size="sm">{r.ssid ?? r.ifname}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.band ?? "—"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{[r.channel, modeWords(r.htmode)].filter(Boolean).join(" · ") || "—"}</Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <ToneValue tone={toneOf.busy(r.busy)}>{r.busy !== undefined ? `${r.busy}%` : "—"}</ToneValue>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm">{r.noise !== undefined ? dbm(r.noise) : "—"}</Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm">{r.txpower !== undefined ? `${r.txpower} dBm` : "—"}</Text>
                    </Table.Td>
                    <Table.Td ta="right">
                      <Text size="sm">{r.clients}</Text>
                    </Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        </Panel>
      )}
      {mesh && (mesh.links.length > 0 || intent.hardware[index].uplink === "mesh") && (
        <Panel title="Mesh links" padded={false}>
          {mesh.links.length ? (
            mesh.links.map((l) => <MeshLink key={l.to} from={name} to={l.to} throughput={l.throughput} />)
          ) : (
            <Text size="sm" c="dimmed" p="md">
              No mesh link: it can be reached only by cable.
            </Text>
          )}
          {(mesh.dropsLargeFrames || mesh.fragmentsOverCable) && (
            <Text size="xs" c="dimmed" px="md" pb="sm">
              {mesh.dropsLargeFrames
                ? `Something between this node and another (a switch) drops the mesh's ${meshMtu}-byte frames, so full-size packets over the cable are lost. Turn off ${where("mesh", "Larger frames over cable")}, or replace that switch.`
                : `A port here does not take ${meshMtu}-byte frames, so the mesh splits its packets over cable: slower. Another port, or a switch that takes them, fixes it.`}
            </Text>
          )}
        </Panel>
      )}
      {clients.length > 0 && (
        <Panel title={`On its Wi-Fi (${clients.length})`} padded={false}>
          {clients.map((c) => (
            <button key={c.mac} type="button" className="onc-list-row" onClick={() => navigate(`/clients/${encodeURIComponent(c.mac)}`)}>
              <ThingIcon icon={kindIcon(c.kind)} />
              <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
                {clientName(c)}
              </Text>
              <Text size="xs" c="dimmed">
                {c.connection.kind === "wifi" ? c.connection.band : ""}
              </Text>
              {c.connection.kind === "wifi" && <ToneValue tone={toneOf.signal(c.connection.signal)}>{dbm(c.connection.signal)}</ToneValue>}
            </button>
          ))}
        </Panel>
      )}
      {role === "router" && live && (
        <Panel title="Networks" padded={false}>
          {live.networks.map((n) => (
            <Group key={n.id} justify="space-between" px="md" py={8} wrap="nowrap" className="onc-list-row" style={{ cursor: "default" }}>
              <Stack gap={0}>
                <Text size="sm">{n.name || n.id}</Text>
                <Text size="xs" c="dimmed">
                  {intent.networks.find((x) => x.id === n.id)?.subnet}
                </Text>
              </Stack>
              <ToneValue tone={n.up === undefined ? "off" : n.up ? "good" : "poor"}>
                {n.up === false ? "Not up" : `${n.clients} ${n.clients === 1 ? "lease" : "leases"}`}
              </ToneValue>
            </Group>
          ))}
        </Panel>
      )}
      {role === "router" && live?.vpn && (live.vpn.clients.length || live.vpn.sites.length || live.vpn.tunnels.length) ? (
        <Panel title="VPN" padded={false}>
          {[...live.vpn.clients.map((c) => ({ ...c, kind: "Remote client" })), ...live.vpn.sites.map((s) => ({ ...s, kind: "Linked site" }))].map(({ name: peer, since, kind }) => {
            const p = peerState(since);
            return (
              <Group key={`${kind}-${peer}`} justify="space-between" px="md" py={8} wrap="nowrap" className="onc-list-row" style={{ cursor: "default" }}>
                <Stack gap={0}>
                  <Text size="sm">{peer}</Text>
                  <Text size="xs" c="dimmed">
                    {kind} · {p.detail ?? `last handshake ${duration(since!)} ago`}
                  </Text>
                </Stack>
                <ToneValue tone={p.connected ? "good" : "off"}>{p.word}</ToneValue>
              </Group>
            );
          })}
          {live.vpn.tunnels.map((t) => (
            <Group key={`tunnel-${t.name}`} justify="space-between" px="md" py={8} wrap="nowrap" className="onc-list-row" style={{ cursor: "default" }}>
              <Stack gap={0}>
                <Text size="sm">{t.name}</Text>
                <Text size="xs" c="dimmed">
                  VPN provider
                </Text>
              </Stack>
              <ToneValue tone={t.up ? "good" : "poor"}>{t.up ? "Up" : "Down"}</ToneValue>
            </Group>
          ))}
        </Panel>
      ) : null}
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        {device?.services && device.services.length > 0 && (
          <Panel title="Services your settings need" padded={false}>
            {device.services.map((s) => (
              <ServiceRow key={s.name} device={name} service={s} />
            ))}
          </Panel>
        )}
        <Panel title="Firmware">
          <Facts
            cols={{ base: 2 }}
            items={[
              ["OpenWrt", device?.version],
              ["Model", device?.model],
              ["Update", update ? <Anchor key="u" href={releaseNotesUrl(update)} target="_blank" rel="noreferrer" size="sm">{update} is out</Anchor> : "Up to date"],
              ["Up for", device?.uptime ? duration(device.uptime) : undefined],
            ]}
          />
          <Anchor component="button" size="xs" mt="sm" onClick={() => navigate("/settings/system/firmware")}>
            {update ? `Upgrade it in ${where("firmware")}` : "Firmware settings"}
          </Anchor>
        </Panel>
      </SimpleGrid>
      {unexpected.length > 0 && (
        <Panel title="Not in your settings" padded={false}>
          {unexpected.map((u) => (
            <Group key={u.id} justify="space-between" px="md" py={8} className="onc-list-row" style={{ cursor: "default" }}>
              <Text size="sm" ff="monospace" fz={13}>
                {u.id}
              </Text>
              <Text size="xs" c="dimmed">
                {u.what}: applying your settings removes it
              </Text>
            </Group>
          ))}
        </Panel>
      )}
      <Panel title="What happened" padded={false}>
        {events.length ? (
          events.slice(0, 30).map((e, i) => (
            <Group key={`${e.at}-${i}`} gap="sm" px="md" py={8} wrap="nowrap" className="onc-list-row" style={{ cursor: "default" }}>
              <Text size="xs" c="dimmed" w={70} style={{ flexShrink: 0 }}>
                {eventTime(e.at)}
              </Text>
              <ToneDot tone={eventTone(e)} />
              <Text size="sm">{e.text}</Text>
            </Group>
          ))
        ) : (
          <Text size="sm" c="dimmed" p="md">
            Nothing has happened to it since the app started watching.
          </Text>
        )}
      </Panel>
      {device?.log && device.log.length > 0 && (
        <Panel title="Its log" padded={false}>
          <Stack gap={0} p="md" style={{ maxHeight: 320, overflow: "auto" }}>
            {[...device.log].reverse().map((l, i) => (
              <Group key={i} gap="sm" wrap="nowrap" align="baseline">
                <Text size="xs" c="dimmed" w={70} style={{ flexShrink: 0 }}>
                  {eventTime(l.at)}
                </Text>
                <Stack gap={0} style={{ minWidth: 0 }}>
                  {l.said && <Text size="sm">{l.said}</Text>}
                  <Text size="xs" c="dimmed" ff="monospace" style={{ overflowWrap: "anywhere" }}>
                    {l.text}
                  </Text>
                </Stack>
              </Group>
            ))}
          </Stack>
        </Panel>
      )}
    </StatusPage>
  );
};
