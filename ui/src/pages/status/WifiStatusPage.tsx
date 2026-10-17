// Wi-Fi: is the air good, and is every client well served? Its verdict;
// each radio (an access point's band, its SSIDs together, as they share its
// air): channel and width, how busy, noise, power, clients; a map of the
// channels per band, your radios as wide as they are, and what a survey
// heard around them; each SSID on the air where; the clients worth a
// nudge, each with its cause; each radio's air over time. Its settings:
// Settings › Wi-Fi.
import { Badge, Button, Group, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { useNavigate } from "react-router";
import type { Intent } from "../../../../src/intent/schema";
import type { Survey } from "../../../../src/status/actions";
import { clientHealth, needsLook, thresholds, tone as toneOf, Tone } from "../../../../src/status/health";
import { radioKey } from "../../../../src/status/history";
import type { RadioView } from "../../../../src/status/views";
import { useAllSeries, useRangeSwitch } from "../../data/history";
import { useNetworkStatus, useWifiSurvey } from "../../data/status";
import { useDraftValue } from "../../form/draft";
import { dbm, Panel, seriesColor, StatusPage, ToneValue, Verdict } from "../../kit/status";
import { SignalBars } from "../../kit/charts";
import { TimeChart } from "../../kit/TimeChart";
import { AttentionRows, clientName, kindIcon, liveLine, modeWords, RangeSwitch, ThingIcon } from "./shared";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** One radio: an access point's band, every SSID on it together (they share its channel and air). */
type Radio = { accessPoint: string; band: string; channel?: number; htmode?: string; noise?: number; txpower?: number; busy?: number; clients: number; ssids: string[] };

const radiosOf = (views: RadioView[]): Radio[] =>
  [...new Set(views.filter((r) => r.band).map((r) => `${r.accessPoint}\n${r.band}`))].map((id) => {
    const [accessPoint, band] = id.split("\n");
    const on = views.filter((r) => r.accessPoint === accessPoint && r.band === band);
    const busy = on.flatMap((r) => (r.busy !== undefined ? [r.busy] : []));
    const first = on[0];
    return {
      accessPoint,
      band,
      channel: first.channel,
      htmode: first.htmode,
      noise: first.noise,
      txpower: first.txpower,
      ...(busy.length ? { busy: Math.max(...busy) } : {}),
      clients: on.reduce((n, r) => n + r.clients, 0),
      ssids: on.flatMap((r) => (r.ssid ? [r.ssid] : [])),
    };
  });

/** Each band's scale: where its channels sit, MHz, and the numbers worth labelling. */
const bandScale: Record<string, { from: number; to: number; mhz: (ch: number) => number; labels: number[] }> = {
  "2.4 GHz": { from: 2400, to: 2484, mhz: (ch) => (ch === 14 ? 2484 : 2407 + 5 * ch), labels: [1, 6, 11] },
  "5 GHz": { from: 5160, to: 5895, mhz: (ch) => 5000 + 5 * ch, labels: [36, 52, 100, 116, 132, 149, 165] },
  "6 GHz": { from: 5945, to: 7125, mhz: (ch) => 5950 + 5 * ch, labels: [1, 33, 65, 97, 129, 161, 193, 225] },
};

/** What a radio occupies, MHz: its channel's block at its width (20, 40, 80, 160 MHz), bonded as the band groups them. */
export const occupied = (band: string, channel: number, htmode?: string): [number, number] => {
  const scale = bandScale[band];
  const width = Number(/(\d+)$/.exec(htmode ?? "")?.[1] ?? 20) || 20;
  const centre = scale.mhz(channel);
  if (band === "2.4 GHz" || width <= 20) return [centre - 10, centre + 10];
  // 5 and 6 GHz bond 20 MHz channels in aligned groups: 5 GHz from 36 (and 149 for the upper band), 6 GHz from 1.
  const base = band === "6 GHz" ? 1 : channel >= 149 ? 149 : 36;
  const group = width / 5;
  const start = base + Math.floor((channel - base) / group) * group;
  return [scale.mhz(start) - 10, scale.mhz(start + group - 4) + 10];
};

/**
 * The channels of one band: each of your radios a row, its block as wide
 * as its channel (bonded as the band groups them), named; under them what
 * the last survey heard (how busy each channel was). In HTML, at percent
 * positions, so its words keep their shape at any width.
 */
const ChannelBand = ({ band, radios, survey }: { band: string; radios: Radio[]; survey?: Survey[] }) => {
  const scale = bandScale[band];
  const busiest = new Map<number, number>();
  (survey ?? []).flatMap((s) => s.channels.filter((c) => c.band === band)).forEach((c) => c.busy !== undefined && busiest.set(c.channel, Math.max(busiest.get(c.channel) ?? 0, c.busy)));
  const neighbours = (survey ?? []).flatMap((s) => s.neighbours.filter((n) => n.band === band)).length;
  const at = (mhz: number) => `${((mhz - scale.from) / (scale.to - scale.from)) * 100}%`;
  const span = (a: number, b: number) => `${((b - a) / (scale.to - scale.from)) * 100}%`;
  const placed = radios.filter((r) => r.channel !== undefined);
  return (
    <Stack gap={4}>
      <Group justify="space-between">
        <Text size="xs" fw={600}>
          {band}
        </Text>
        {neighbours > 0 && (
          <Text size="xs" c="dimmed">
            {plural(neighbours, "other network")} heard around
          </Text>
        )}
      </Group>
      <div style={{ position: "relative", borderTop: "1px solid var(--onc-separator)", borderBottom: "1px solid var(--onc-separator)", padding: "6px 0" }}>
        {placed.map((r) => {
          const [a, b] = occupied(band, r.channel!, r.htmode);
          return (
            <div key={r.accessPoint} style={{ position: "relative", height: 20, marginBottom: 4 }}>
              <div
                title={`${r.accessPoint}: channel ${r.channel}${modeWords(r.htmode) ? `, ${modeWords(r.htmode)}` : ""}`}
                style={{ position: "absolute", left: at(a), width: span(a, b), minWidth: 4, top: 0, bottom: 0, background: seriesColor[0], borderRadius: 4, overflow: "hidden" }}
              >
                <Text size="11px" c="white" fw={600} px={6} lh="20px" truncate>
                  {r.accessPoint} · {r.channel}
                </Text>
              </div>
            </div>
          );
        })}
        {busiest.size > 0 && (
          <div style={{ position: "relative", height: 18 }} aria-label={`${band}: how busy each channel was`}>
            {[...busiest.entries()].map(([channel, busy]) => {
              const mhz = scale.mhz(channel);
              const t: Tone = toneOf.busy(busy);
              return (
                <div
                  key={channel}
                  title={`Channel ${channel}: ${busy}% busy`}
                  style={{
                    position: "absolute",
                    left: at(mhz - 8),
                    width: span(mhz - 8, mhz + 8),
                    bottom: 0,
                    height: `${Math.max(8, busy)}%`,
                    background: t === "good" ? "var(--onc-label-2)" : `var(--mantine-color-${t === "fair" ? "orange" : "red"}-6)`,
                    opacity: 0.6,
                    borderRadius: "2px 2px 0 0",
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
      <div style={{ position: "relative", height: 14 }}>
        {scale.labels.map((ch) => (
          <Text key={ch} size="10px" c="dimmed" style={{ position: "absolute", left: at(scale.mhz(ch)), transform: "translateX(-50%)" }}>
            {ch}
          </Text>
        ))}
      </div>
    </Stack>
  );
};

/** What a survey heard around one access point: how busy each channel was, and the strongest networks not yours. */
const SurveyCard = ({ survey }: { survey: Survey }) => (
  <Panel title={`Around ${survey.accessPoint}`}>
    <Stack gap="md">
      {[...new Set(survey.channels.map((c) => c.band))].map((band) => (
        <Stack key={band} gap={4}>
          <Text size="xs" c="dimmed">
            {band}: how busy each channel was, anyone's traffic counted
          </Text>
          {survey.channels
            .filter((c) => c.band === band)
            .map((c) => {
              const heard = survey.neighbours.filter((n) => n.channel === c.channel).length;
              const t = toneOf.busy(c.busy);
              return (
                <Group key={c.channel} gap="sm" wrap="nowrap">
                  <Text size="xs" w={34} ta="right" fw={c.ours ? 700 : 400}>
                    {c.channel}
                  </Text>
                  <div style={{ flex: 1, height: 8, background: "var(--onc-separator)", borderRadius: 4, overflow: "hidden" }}>
                    {/* Unknown where the radio's counters cannot be right (mt76#1135): no bar, rather than a wrong one. */}
                    {c.busy !== undefined && (
                      <div style={{ width: `${c.busy}%`, height: "100%", background: t === "good" ? "var(--onc-label-2)" : `var(--mantine-color-${t === "fair" ? "orange" : "red"}-6)` }} />
                    )}
                  </div>
                  <Text size="xs" c="dimmed" w={170}>
                    {c.busy === undefined ? "unknown" : `${c.busy}% busy`}
                    {heard ? ` · ${plural(heard, "network")}` : ""}
                    {c.ours ? " · yours" : ""}
                  </Text>
                </Group>
              );
            })}
        </Stack>
      ))}
      {survey.neighbours.length > 0 && (
        <Stack gap={4}>
          <Text size="xs" c="dimmed">
            Strongest networks around, not yours (one using your network's name first)
          </Text>
          {survey.neighbours.slice(0, 8).map((n, i) => (
            <Group key={i} gap="sm" wrap="nowrap">
              <SignalBars dbm={n.signal} />
              <Text size="sm" style={{ flex: 1 }} truncate fw={n.impostor ? 600 : undefined}>
                {n.ssid ?? <Text span c="dimmed">Hidden</Text>}
                {n.impostor && " · not one of your access points"}
              </Text>
              <Text size="xs" c="dimmed">
                {n.band} · channel {n.channel} · {dbm(n.signal)}
              </Text>
            </Group>
          ))}
        </Stack>
      )}
    </Stack>
  </Panel>
);

export const WifiStatusPage = () => {
  const navigate = useNavigate();
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus();
  const survey = useWifiSurvey();
  const series = useAllSeries();
  const range = useRangeSwitch().value;
  const live = status.data;
  const radios = radiosOf(live?.radios ?? []);
  const clients = (live?.clientList ?? []).filter((c) => c.state === "online" && c.connection.kind === "wifi");
  const nudges = clients.map((c) => ({ c, h: clientHealth(c, live?.radios ?? []) })).filter(({ h }) => needsLook(h));
  const busiest = radios.filter((r) => r.busy !== undefined).sort((a, b) => b.busy! - a.busy!)[0];
  const attention = (live?.attention ?? []).filter((a) => a.id.startsWith("ssid:") || a.id.startsWith("mesh:"));
  const offAir = attention.some((a) => a.id.startsWith("ssid:"));
  const tone: Tone = !live ? "off" : offAir ? "poor" : nudges.length || toneOf.busy(busiest?.busy) === "poor" ? "fair" : "good";
  const bands = [...new Set(radios.map((r) => r.band))].sort();
  const toPoints = (key: string): [number, number][] => (series[key] ?? []).map(([t, v]) => [t, v]);
  return (
    <StatusPage
      title="Wi-Fi"
      live={liveLine(status)}
      actions={
        <>
          <RangeSwitch />
          <Button size="xs" variant="default" onClick={() => navigate("/settings/wifi")}>
            Wi-Fi settings
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Verdict tone={tone} detail={busiest ? `Busiest: ${busiest.accessPoint} · ${busiest.band} · ${busiest.busy}% of the air in use` : undefined}>
          {!live ? "Reading the access points…" : `${plural(clients.length, "client")} · ${nudges.length ? `${nudges.length} could be better served` : "every client served well"}`}
        </Verdict>
        {attention.length > 0 && <AttentionRows items={attention} />}
      </Stack>
      <Panel title="Radios" padded={false}>
        {radios.length === 0 ? (
          <Text size="sm" c="dimmed" p="md">
            {live ? "No access point is broadcasting." : "Reading the access points…"}
          </Text>
        ) : (
          <Table.ScrollContainer minWidth={640} type="native">
            <Table verticalSpacing={8} horizontalSpacing="md" withRowBorders={false}>
              <Table.Thead>
                <Table.Tr>
                  {["Access point", "Band", "Channel", "Networks", "Busy", "Noise", "Power", "Clients"].map((h, i) => (
                    <Table.Th key={h} ta={i >= 4 ? "right" : undefined}>
                      <Text span size="xs" c="dimmed" fw={500}>
                        {h}
                      </Text>
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {radios.map((r) => (
                  <Table.Tr key={`${r.accessPoint}-${r.band}`} className="onc-table-row" tabIndex={0} onClick={() => navigate(`/devices/${encodeURIComponent(r.accessPoint)}`)} onKeyDown={(e) => e.key === "Enter" && navigate(`/devices/${encodeURIComponent(r.accessPoint)}`)}>
                    <Table.Td>
                      <Text size="sm" fw={500}>
                        {r.accessPoint}
                      </Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{r.band}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm">{[r.channel, modeWords(r.htmode)].filter(Boolean).join(" · ") || "—"}</Text>
                    </Table.Td>
                    <Table.Td>
                      <Text size="sm" truncate maw={200}>
                        {r.ssids.join(", ") || "—"}
                      </Text>
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
        )}
      </Panel>
      {radios.length > 0 && (
        <Panel
          title="Channels"
          actions={
            <Button size="xs" variant="default" loading={survey.isPending} onClick={() => survey.mutate()}>
              {survey.data ? "Survey again" : "Survey the air"}
            </Button>
          }
        >
          <Stack gap="lg">
            {bands.map((band) => (
              <ChannelBand key={band} band={band} radios={radios.filter((r) => r.band === band)} survey={survey.data?.surveys} />
            ))}
            <Text size="xs" c="dimmed">
              {survey.isError
                ? (survey.error as Error).message
                : survey.data
                  ? [
                      survey.data.surveys.length ? "Under each band: how busy each channel was when surveyed (grey is fine, amber busy, red crowded)." : "The access points did not report a survey.",
                      ...survey.data.failed.map((f) => `${f.accessPoint} was not surveyed: ${f.error}`),
                    ].join(" ")
                  : "A survey has each access point listen around it for a few seconds, in turn: its clients may notice a short pause."}
            </Text>
          </Stack>
        </Panel>
      )}
      {survey.data && survey.data.surveys.length > 0 && (
        <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
          {survey.data.surveys.map((s) => (
            <SurveyCard key={s.accessPoint} survey={s} />
          ))}
        </SimpleGrid>
      )}
      <Panel title="Networks on the air" padded={false}>
        {intent.wifi.networks.map((w) => {
          const now = live?.ssids.find((s) => s.ssid === w.ssid);
          const on = now && now.accessPoints.length > 0;
          const network = intent.networks.find((n) => n.id === w.network)?.name;
          return (
            <Group key={w.ssid} justify="space-between" px="md" py={10} wrap="nowrap" className="onc-list-row" style={{ cursor: "default" }}>
              <Stack gap={0} style={{ minWidth: 0 }}>
                <Text size="sm" fw={500}>
                  {w.ssid || "Unnamed"}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {[network, now ? (on ? `on ${now.accessPoints.join(", ")}` : "not on the air") : undefined].filter(Boolean).join(" · ")}
                </Text>
              </Stack>
              <ToneValue tone={!now ? "off" : w.enabled === false ? "off" : on ? "good" : "poor"}>
                {w.enabled === false ? "Off" : now ? plural(now.clients, "client") : "—"}
              </ToneValue>
            </Group>
          );
        })}
      </Panel>
      <Panel title="Worth a nudge" padded={false}>
        {nudges.length === 0 ? (
          <Text size="sm" c="dimmed" p="md">
            {live ? "Every client has a good signal, on a quiet channel, on its best access point and band." : "Reading…"}
          </Text>
        ) : (
          nudges.map(({ c, h }) => (
            <button key={c.mac} type="button" className="onc-list-row" onClick={() => navigate(`/clients/${encodeURIComponent(c.mac)}`)}>
              <ThingIcon icon={kindIcon(c.kind)} />
              <Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
                <Text size="sm" fw={500} truncate>
                  {clientName(c)}
                </Text>
                <Text size="xs" c="dimmed" truncate>
                  {h.causes.map((x) => x.text).join(" · ")}
                </Text>
              </Stack>
              {c.connection.kind === "wifi" && (
                <Badge variant="default" radius="sm" size="xs" style={{ textTransform: "none", fontWeight: 500 }}>
                  {c.connection.accessPoint} · {c.connection.band}
                </Badge>
              )}
            </button>
          ))
        )}
      </Panel>
      {radios.length > 0 && (
        <Panel title="Each radio's air, over time">
          <SimpleGrid cols={{ base: 1, sm: 2, md: 3 }} spacing="lg">
            {radios.map((r) => (
              <Stack key={`${r.accessPoint}-${r.band}`} gap={4}>
                <Text size="xs" c="dimmed">
                  {r.accessPoint} · {r.band}: busy
                </Text>
                <TimeChart
                  label={`${r.accessPoint} ${r.band} busy`}
                  range={range}
                  series={[{ label: "Busy", points: toPoints(radioKey("busy", r.accessPoint, r.band)) }]}
                  format={(v) => `${Math.round(v)}%`}
                  max={100}
                  height={90}
                  bands={[
                    { from: thresholds.busy.good, to: thresholds.busy.fair, tone: "fair" },
                    { from: thresholds.busy.fair, tone: "poor" },
                  ]}
                />
              </Stack>
            ))}
          </SimpleGrid>
        </Panel>
      )}
    </StatusPage>
  );
};
