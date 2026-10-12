// Performance: how well the internet and the Wi-Fi are doing. The line's
// throughput and latency over time (kept in this browser), what the router
// measures of it now, a speed test on request; each access point's radios,
// a survey of the air around them on request, and which access points hear
// each client (roaming).
import { Badge, Button, Group, Progress, SimpleGrid, Stack, Text } from "@mantine/core";
import { where } from "../../../../src/intent/places";
import type { Intent } from "../../../../src/intent/schema";
import type { Survey } from "../../../../src/status/actions";
import { bitsWords, useSeries } from "../../data/history";
import { useNetworkStatus, useSpeedTest, useWifiSurvey } from "../../data/status";
import { duration } from "../../facts";
import { useDraftValue } from "../../form/draft";
import { AreaChart, ChartCard, SignalBars, Tile } from "../../kit/charts";
import { EmptyState, Section, SettingRow, SettingsPage, StatusDot } from "../../kit/layout";
import { bytes, liveLine, Muted } from "./shared";

/** "HE80" as people say it: Wi-Fi 6, 80 MHz. */
const modeWords = (htmode?: string) => {
  const m = /^(EHT|HE|VHT|HT)(\d+)/.exec(htmode ?? "");
  if (!m) return undefined;
  const generation = { EHT: "Wi-Fi 7", HE: "Wi-Fi 6", VHT: "Wi-Fi 5", HT: "Wi-Fi 4" }[m[1]];
  return `${generation} · ${m[2]} MHz`;
};

const bandColor = (band?: string) => (band === "6 GHz" ? "grape" : band === "5 GHz" ? "blue" : "teal");

const BandBadge = ({ band }: { band?: string }) =>
  band ? (
    <Badge variant="light" color={bandColor(band)} radius="sm" size="sm" style={{ textTransform: "none" }}>
      {band}
    </Badge>
  ) : null;

const last = (series: [number, number][]) => series[series.length - 1]?.[1];

const Internet = ({ intent }: { intent: Intent }) => {
  const status = useNetworkStatus("performance");
  const speed = useSpeedTest();
  const down = useSeries("down");
  const up = useSeries("up");
  const latency = useSeries("latency");
  const check = status.data?.internetCheck;
  const peak = Math.max(0, ...down.map((p) => p[1]));
  return (
    <>
      <SimpleGrid cols={{ base: 1, xs: 3 }} spacing="sm">
        <Tile label="Downloading now" value={bitsWords(last(down))} color="blue" sub={peak ? `Peak ${bitsWords(peak)}` : "Measured between reads"} />
        <Tile label="Uploading now" value={bitsWords(last(up))} color="teal" sub="All devices together" />
        <Tile
          label="Latency"
          value={check?.latencyMs !== undefined ? `${Math.round(check.latencyMs)} ms` : check ? "No answer" : "—"}
          color={check?.latencyMs === undefined ? undefined : check.latencyMs < 30 ? "green" : check.latencyMs < 80 ? "yellow" : "red"}
          sub="To 1.1.1.1, from the router"
        />
      </SimpleGrid>
      <ChartCard title="Throughput" legend={[{ label: "Down", color: "blue" }, { label: "Up", color: "teal" }]} span={down[0]?.[0]}>
        <AreaChart series={[down, up]} colors={["blue", "teal"]} height={110} />
      </ChartCard>
      <ChartCard title="Latency" legend={[{ label: "ms", color: "violet" }]} span={latency[0]?.[0]}>
        <AreaChart series={[latency]} colors={["violet"]} height={70} />
      </ChartCard>
      <Section title="Connections">
        {(status.data?.connections ?? intent.internet.connections.map((c) => ({ id: c.id, name: c.name, ipv4: [], ipv6: [] }))).map((c) => (
          <SettingRow
            key={c.id}
            label={c.name || c.id}
            description={[
              c.ipv4.join(", ") || undefined,
              c.ipv6.length ? `IPv6 ${c.ipv6[0]}` : undefined,
              "line" in c && c.line ? `${c.line.state} ${duration(c.line.since)}` : "uptime" in c && c.uptime !== undefined ? `up ${duration(c.uptime)}` : undefined,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <Group gap={6} wrap="nowrap">
              {"up" in c && c.up !== undefined && <StatusDot color={c.up ? "green" : "red"} />}
              <Muted>{"inUse" in c && c.inUse ? "In use" : "up" in c && c.up ? "Ready" : "up" in c && c.up === false ? "Down" : "—"}</Muted>
            </Group>
          </SettingRow>
        ))}
      </Section>
      <Section title="From the router">
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
        <SettingRow label="Speed" description={speed.isError ? (speed.error as Error).message : "Downloads test data for a few seconds, from the router."}>
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
    </>
  );
};

/** How busy each channel is, a bar each, ours marked; and the networks heard on it. */
const SurveyCard = ({ survey }: { survey: Survey }) => {
  const bands = [...new Set(survey.channels.map((c) => c.band))];
  return (
    <ChartCard title={`Around ${survey.accessPoint}`}>
      <Stack gap="md">
        {bands.map((band) => (
          <Stack key={band} gap={6}>
            <Group gap={6}>
              <BandBadge band={band} />
              <Text size="xs" c="dimmed">
                How busy each channel is, anyone's traffic counted
              </Text>
            </Group>
            {survey.channels
              .filter((c) => c.band === band)
              .map((c) => {
                const heard = survey.neighbours.filter((n) => n.channel === c.channel).length;
                return (
                  <Group key={c.channel} gap="sm" wrap="nowrap">
                    <Text size="xs" w={34} ta="right" fw={c.ours ? 700 : 400}>
                      {c.channel}
                    </Text>
                    <Progress
                      value={c.busy}
                      color={c.busy >= 60 ? "red" : c.busy >= 30 ? "orange" : bandColor(band)}
                      size="lg"
                      radius="sm"
                      style={{ flex: 1 }}
                    />
                    <Text size="xs" c="dimmed" w={150}>
                      {c.busy}% busy{heard ? ` · ${heard} network${heard === 1 ? "" : "s"}` : ""}
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
              Strongest networks around, not yours
            </Text>
            {survey.neighbours.slice(0, 8).map((n, i) => (
              <Group key={i} gap="sm" wrap="nowrap">
                <SignalBars dbm={n.signal} />
                <Text size="sm" style={{ flex: 1 }} truncate>
                  {n.ssid ?? <Text span c="dimmed">Hidden</Text>}
                </Text>
                <Text size="xs" c="dimmed">
                  {n.band} · channel {n.channel}
                </Text>
              </Group>
            ))}
          </Stack>
        )}
      </Stack>
    </ChartCard>
  );
};

const Wifi = () => {
  const status = useNetworkStatus("performance");
  const survey = useWifiSurvey();
  const radios = status.data?.radios ?? [];
  const accessPoints = [...new Set(radios.map((r) => r.accessPoint))];
  const clients = status.data?.clientList ?? [];
  // Roaming: clients more than one access point hears, with who hears them how well.
  const roaming = clients.filter((c) => new Set(c.heardBy.map((h) => h.accessPoint)).size > 1);
  return (
    <>
      {accessPoints.length === 0 && (
        <Section>
          <EmptyState>{status.data ? "No access point is broadcasting." : "Reading the access points…"}</EmptyState>
        </Section>
      )}
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="sm">
        {accessPoints.flatMap((ap) =>
          radios
            .filter((r) => r.accessPoint === ap)
            .map((r) => (
              <ChartCard
                key={`${ap}-${r.ifname}`}
                title={
                  <Group gap={8} wrap="nowrap">
                    <span>{r.ssid ?? r.ifname}</span>
                    <BandBadge band={r.band} />
                  </Group>
                }
              >
                <Group justify="space-between" align="flex-end" wrap="nowrap">
                  <Stack gap={2}>
                    <Text size="xs" c="dimmed">
                      {ap}
                    </Text>
                    <Text size="sm">{[r.channel !== undefined ? `Channel ${r.channel}` : undefined, modeWords(r.htmode)].filter(Boolean).join(" · ")}</Text>
                    <Text size="xs" c="dimmed">
                      {[r.txpower !== undefined ? `${r.txpower} dBm power` : undefined, r.noise !== undefined ? `noise ${r.noise} dBm` : undefined]
                        .filter(Boolean)
                        .join(" · ")}
                    </Text>
                  </Stack>
                  <Stack gap={0} align="flex-end">
                    <Text fz={24} fw={600} lh={1}>
                      {r.clients}
                    </Text>
                    <Text size="xs" c="dimmed">
                      connected
                    </Text>
                  </Stack>
                </Group>
              </ChartCard>
            ))
        )}
      </SimpleGrid>
      <Section
        title="The air around"
        actions={
          <Button size="xs" variant="default" loading={survey.isPending} onClick={() => survey.mutate()}>
            {survey.data ? "Survey again" : "Survey"}
          </Button>
        }
      >
        <SettingRow
          label="Channels and neighbouring networks"
          description={
            survey.isError
              ? (survey.error as Error).message
              : survey.data
                ? survey.data.surveys.length
                  ? `Pick a quieter channel in ${where("radios")} if yours is busy.`
                  : "The access points did not report a survey."
                : "Each access point listens around it for a few seconds: its clients may notice a short pause."
          }
        />
      </Section>
      {survey.data?.surveys.map((s) => <SurveyCard key={s.accessPoint} survey={s} />)}
      <Section title="Roaming" description="Which access points hear each device, and how well: a device on the weaker one while a stronger one hears it is a candidate to move.">
        {accessPoints.length < 2 ? (
          <SettingRow label="One access point" description="With one, there is nowhere to roam to." />
        ) : roaming.length === 0 ? (
          <SettingRow label="No device is heard by more than one access point" description="Roaming information comes from usteer on each access point." />
        ) : (
          roaming.map((c) => {
            const on = c.heardBy.find((h) => h.connected);
            const best = [...c.heardBy].sort((a, b) => (b.signal ?? -999) - (a.signal ?? -999))[0];
            const better = on && best && best.accessPoint !== on.accessPoint && (best.signal ?? -999) - (on.signal ?? -999) >= 10;
            return (
              <SettingRow
                key={c.mac}
                label={c.name ?? c.mac}
                description={better ? `${best.accessPoint} hears it better` : on ? `On ${on.accessPoint}` : undefined}
              >
                <Group gap="md" wrap="nowrap">
                  {c.heardBy.map((h) => (
                    <Group key={`${h.accessPoint}-${h.band}`} gap={4} wrap="nowrap">
                      <SignalBars dbm={h.signal} />
                      <Text size="xs" fw={h.connected ? 600 : 400} c={h.connected ? undefined : "dimmed"}>
                        {h.accessPoint}
                      </Text>
                    </Group>
                  ))}
                </Group>
              </SettingRow>
            );
          })
        )}
      </Section>
    </>
  );
};

export const PerformancePage = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("performance");
  return (
    <SettingsPage title="Performance" description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}>
      <Internet intent={intent} />
      <Text fw={600} size="lg" mt="md">
        Wi-Fi
      </Text>
      <Wifi />
    </SettingsPage>
  );
};
