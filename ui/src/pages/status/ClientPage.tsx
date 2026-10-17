// One client: how it is served and why (its verdict names the cause and
// what would help), what it is and where, its signal, link and traffic over
// the last day (each roam marked), which access points hear it, and what
// happened to it: joins, leaves and roams (src/status/moves.ts) among its events. Its
// one action gives it a fixed address (a draft edit, saved as any other).
import { Anchor, Button, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { useNavigate } from "react-router";
import type { Intent } from "../../../../src/intent/schema";
import { clientHealth, thresholds, type Tone } from "../../../../src/status/health";
import { clientRange } from "../../../../src/status/history";
import type { ClientView } from "../../../../src/status/views";
import { eventTone, useClientDetail, useNetworkStatus } from "../../data/status";
import { ago, duration } from "../../facts";
import { useDraft, useDraftValue } from "../../form/draft";
import { bitsWords, bytes } from "../../kit/format";
import { dbm, Facts, mbit, Panel, StatusPage, ToneDot, ToneValue, Verdict } from "../../kit/status";
import { tone as toneOf } from "../../../../src/status/health";
import { TimeChart } from "../../kit/TimeChart";
import { clientName, eventsAbout, eventTime, liveLine } from "./shared";

type Point = [number, number];
const points = (series?: [number, number, number][]): Point[] => (series ?? []).map(([t, v]) => [t, v]);

/** A fixed address: its address now, under its name, in the draft; the network's page shows it to save. */
const useReserve = (client: ClientView | undefined) => {
  const draft = useDraft();
  const navigate = useNavigate();
  const intent: Intent = useDraftValue();
  const index = intent.networks.findIndex((n) => n.id === client?.network);
  if (!client?.ipv4 || index < 0 || client.reserved) return undefined;
  return () => {
    const network = intent.networks[index];
    const name = (client.name ?? `device-${client.mac.slice(-5).replace(":", "")}`).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    draft.set(`networks.${index}.dhcp.reservations`, [...network.dhcp.reservations, { name, mac: client.mac, address: client.ipv4! }]);
    navigate(`/settings/networks/${index}`);
  };
};

const generations: Record<number, string> = { 4: "Wi-Fi 4", 5: "Wi-Fi 5", 6: "Wi-Fi 6", 7: "Wi-Fi 7" };

export const ClientPage = ({ mac }: { mac: string }) => {
  const navigate = useNavigate();
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus();
  const live = status.data;
  const detail = useClientDetail(mac).data;
  const client = live?.clientList?.find((c) => c.mac === mac);
  const known = detail?.known;
  const reserve = useReserve(client);
  const name = client ? clientName(client) : (known?.name ?? mac);
  const crumbs = [{ label: "Clients", onClick: () => navigate("/clients") }, { label: name }];
  const health = client ? clientHealth(client, live?.radios ?? []) : undefined;
  const wifi = client?.connection.kind === "wifi" ? client.connection : undefined;
  // Its own moves and the network's events about it, newest first.
  const happened = [
    ...eventsAbout(live?.events, `client:${mac}`).map((e) => ({ at: e.at, text: e.text, tone: eventTone(e) })),
    // A move is neither good nor bad: grey, as an event that only informs.
    ...(detail?.moves ?? []).map((m) => ({ at: m.at, text: m.text, tone: "off" as Tone })),
  ].sort((a, b) => b.at - a.at);
  const roams = (detail?.moves ?? []).filter((m) => m.kind === "roamed" || m.kind === "band").map((m) => ({ at: m.at, text: m.text, tone: "off" as Tone }));
  const history = detail?.history ?? {};
  if (live && !client && !known) {
    return (
      <StatusPage title={crumbs} live={liveLine(status)}>
        <Verdict tone="off">Not seen</Verdict>
        <Text size="sm" c="dimmed">
          No device with the MAC {mac} is on the network or remembered.
        </Text>
      </StatusPage>
    );
  }
  const headline = !client
    ? `Last seen ${known ? ago(known.lastSeen) : "a while ago"}`
    : client.state !== "online"
      ? `Away · last seen ${client.lastSeen ? ago(client.lastSeen) : "a while ago"}`
      : wifi
        ? [health?.tone === "poor" ? "Poorly served" : health?.causes.length ? "Could be better" : "Well served", wifi.accessPoint, wifi.band, dbm(wifi.signal), wifi.txRate !== undefined ? mbit(wifi.txRate) : undefined]
            .filter(Boolean)
            .join(" · ")
        : "Connected by cable";
  const networkIndex = intent.networks.findIndex((n) => n.id === (client?.network ?? known?.network));
  const networkName = intent.networks[networkIndex]?.name;
  // Its fixed address in the settings, if it has one: the setting its name and address come from.
  const reservation = intent.networks
    .flatMap((n, i) => (n.dhcp?.reservations ?? []).map((r, j) => ({ r, path: `networks.${i}.dhcp.reservations.${j}` })))
    .find(({ r }) => r.mac.toLowerCase() === mac);
  const ssidIndex = wifi ? intent.wifi.networks.findIndex((w) => w.ssid === wifi.ssid) : -1;
  const apIndex = wifi ? intent.hardware.findIndex((d) => d.name === wifi.accessPoint) : -1;
  const bandKey = wifi?.band?.startsWith("2") ? "2g" : wifi?.band?.startsWith("5") ? "5g" : wifi?.band?.startsWith("6") ? "6g" : undefined;
  return (
    <StatusPage title={crumbs} live={liveLine(status)}>
      <Verdict
        tone={health?.tone ?? "off"}
        detail={health?.causes.length ? health.causes.map((c) => c.text).join(" · ") : undefined}
        actions={
          reserve && (
            <Button size="xs" variant="default" onClick={reserve}>
              Give it a fixed address
            </Button>
          )
        }
      >
        {headline}
      </Verdict>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Panel title="What it is">
          <Facts
            cols={{ base: 2 }}
            items={[
              ["Name", name, reservation && `${reservation.path}.name`],
              ["Model", client?.model ?? known?.model],
              ["MAC", <span key="mac">{mac}{client?.private ? " · private" : ""}</span>],
              ["IPv4", client?.ipv4 ?? known?.ipv4],
              ["IPv6", client?.ipv6.length ? <Stack key="v6" gap={0}>{client.ipv6.map((a) => <span key={a}>{a}</span>)}</Stack> : undefined],
              ["Network", networkName, networkIndex >= 0 ? `networks.${networkIndex}` : undefined],
              ["Fixed address", client?.reserved ? "Yes" : "No", reservation?.path],
              ["First seen", client?.firstSeen ? ago(client.firstSeen) : known ? ago(known.firstSeen) : undefined],
            ]}
          />
          {client?.private && (
            <Text size="xs" c="dimmed" mt="sm">
              A private address: the device made this MAC up for this network, and may use another elsewhere or later.
            </Text>
          )}
        </Panel>
        <Panel title="How it is connected">
          {wifi ? (
            <Facts
              cols={{ base: 2 }}
              items={[
                [
                  "Access point",
                  <Anchor key="ap" component="button" size="sm" onClick={() => navigate(`/devices/${encodeURIComponent(wifi.accessPoint)}`)}>
                    {wifi.accessPoint}
                  </Anchor>,
                ],
                ["Network name", wifi.ssid, ssidIndex >= 0 ? `wifi.networks.${ssidIndex}` : undefined],
                ["Band and channel", [wifi.band, wifi.channel !== undefined ? `channel ${wifi.channel}` : undefined].filter(Boolean).join(", ") || undefined, apIndex >= 0 && bandKey && bandKey !== "6g" ? `hardware.${apIndex}.radios.${bandKey}.channel` : undefined],
                ["Signal", <ToneValue key="s" tone={toneOf.signal(wifi.signal)}>{dbm(wifi.signal)}</ToneValue>],
                ["Link, to it", wifi.txRate !== undefined ? mbit(wifi.txRate) : undefined],
                ["Link, from it", wifi.rxRate !== undefined ? mbit(wifi.rxRate) : undefined],
                ["Standard", wifi.generation ? generations[wifi.generation] : undefined],
                ["Connected for", wifi.connected !== undefined ? duration(wifi.connected) : undefined],
              ]}
            />
          ) : (
            <Facts
              cols={{ base: 2 }}
              items={[
                ["Connection", client?.connection.kind === "wired" ? "Cable" : client?.state === "online" ? "Answering, not on Wi-Fi" : "Away"],
                ["Last on", known?.connection === "wifi" ? [known.accessPoint, known.band].filter(Boolean).join(" · ") : known?.connection === "wired" ? "Cable" : undefined],
                ["Used", client?.traffic ? `↓ ${bytes(client.traffic.down)} · ↑ ${bytes(client.traffic.up)}` : undefined],
                ["Over", client?.traffic ? (client.traffic.over === "month" ? "this month" : "since it joined") : undefined],
              ]}
            />
          )}
          {wifi && client?.traffic && (
            <Text size="xs" c="dimmed" mt="sm">
              Used ↓ {bytes(client.traffic.down)} · ↑ {bytes(client.traffic.up)} {client.traffic.over === "month" ? "this month" : "since it joined"}. A link's rate drops while it is idle: it says what the link can do only while the device is busy.
            </Text>
          )}
        </Panel>
      </SimpleGrid>
      <Panel title="Signal, the last day">
        <TimeChart
          label="Signal"
          range="day"
          step={clientRange}
          series={[{ label: "Signal", points: points(history.signal) }]}
          format={(v) => dbm(v)}
          min={-90}
          max={-30}
          bands={[
            { from: -90, to: thresholds.signal.fair, tone: "poor" },
            { from: thresholds.signal.fair, to: thresholds.signal.good, tone: "fair" },
          ]}
          events={roams}
          height={120}
        />
      </Panel>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Panel title="Link to it">
          <TimeChart label="Link rate" range="day" step={clientRange} series={[{ label: "Link", points: points(history.rate) }]} format={(v) => mbit(v)} height={110} />
        </Panel>
        <Panel title="Traffic">
          <TimeChart
            label="Traffic"
            range="day"
            step={clientRange}
            series={[
              { label: "Down", points: points(history.down) },
              { label: "Up", points: points(history.up) },
            ]}
            format={(v) => bitsWords(v)}
            height={110}
          />
        </Panel>
      </SimpleGrid>
      {client && client.heardBy.length > 0 && (
        <Panel title="Which access points hear it" padded={false}>
          {[...client.heardBy]
            .sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999))
            .map((h) => (
              <Group key={`${h.accessPoint}-${h.band}`} justify="space-between" px="md" py={8} className="onc-list-row" style={{ cursor: "default" }}>
                <Text size="sm" fw={h.connected ? 600 : 400}>
                  {h.accessPoint}
                  {h.band ? ` · ${h.band}` : ""}
                  {h.connected ? " · connected" : ""}
                </Text>
                <ToneValue tone={toneOf.signal(h.signal)}>{dbm(h.signal)}</ToneValue>
              </Group>
            ))}
        </Panel>
      )}
      <Panel title="What happened" padded={false}>
        {happened.length ? (
          happened.slice(0, 30).map((e, i) => (
            <Group key={`${e.at}-${i}`} gap="sm" px="md" py={8} wrap="nowrap" className="onc-list-row" style={{ cursor: "default" }}>
              <Text size="xs" c="dimmed" w={84} style={{ flexShrink: 0, whiteSpace: "nowrap" }}>
                {eventTime(e.at)}
              </Text>
              <ToneDot tone={e.tone} />
              <Text size="sm">{e.text}</Text>
            </Group>
          ))
        ) : (
          <Text size="sm" c="dimmed" p="md">
            {client?.firstSeen ? `First seen ${ago(client.firstSeen)}; nothing else told of it.` : "Nothing told of it yet."}
          </Text>
        )}
      </Panel>
    </StatusPage>
  );
};
