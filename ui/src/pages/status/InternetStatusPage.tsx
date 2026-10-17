// Internet: is the line good, and was it? Its verdict; each line as the
// router has it (address, the prefix delegated, the gateway, how it
// connects); whether it was up, an hour or a day a cell; the round trip to
// the internet and to the provider's own router, loss and throughput, with
// what happened marked; a speed test with latency under load, kept; and the
// router's own view: the address the internet sees, DNS and each DNS-over-
// HTTPS provider answering, smart queueing. Its settings: Settings › Internet.
import { Button, Group, SimpleGrid, Stack, Table, Text } from "@mantine/core";
import { useNavigate } from "react-router";
import { isPrivateRange } from "../../../../src/intent/addresses";
import { dohPorts, fallbackOf, providerLabels } from "../../../../src/intent/dns";
import type { Intent } from "../../../../src/intent/schema";
import { bloatGrade } from "../../../../src/status/actions";
import { thresholds, tone as toneOf, Tone, worst } from "../../../../src/status/health";
import { useRangeSwitch, useSeries, useSeriesPoints } from "../../data/history";
import { eventTone, throughputNow, useNetworkStatus, useSpeedTest, useSpeedTests } from "../../data/status";
import { duration } from "../../facts";
import { useDraftValue } from "../../form/draft";
import { bitsWords } from "../../kit/format";
import { OutageStrip } from "../../kit/OutageStrip";
import { Facts, mbit, ms, Panel, StatusPage, ToneValue, Verdict } from "../../kit/status";
import { TimeChart } from "../../kit/TimeChart";
import { AttentionRows, eventsAbout, lately, lineState, liveLine, RangeSwitch } from "./shared";

/** What a line's address says of what sits before the router: nothing, another router, or the provider's NAT (CGNAT). */
const natOf = (address?: string) => {
  const ip = address?.split("/")[0];
  if (!ip) return undefined;
  const [a, b] = ip.split(".").map(Number);
  if (a === 100 && b >= 64 && b < 128) return "behind the provider's NAT (CGNAT)";
  return isPrivateRange(`${ip}/32`) ? "behind another router" : undefined;
};

const percentWords = (v: number) => `${Math.round(v * 10) / 10}%`;

const SpeedTestPanel = () => {
  const speed = useSpeedTest();
  const tests = useSpeedTests().data ?? [];
  return (
    <Panel
      title="Speed test"
      actions={
        <Button size="xs" variant="default" loading={speed.isPending} onClick={() => speed.mutate()}>
          {tests.length ? "Test again" : "Test speed"}
        </Button>
      }
      padded={false}
    >
      <Stack gap={0}>
        <Text size="xs" c="dimmed" px="md" pt="sm" pb={tests.length ? 4 : "sm"}>
          {speed.isError
            ? (speed.error as Error).message
            : speed.isPending
              ? "Testing from the router: eight seconds down, eight up, about half a minute in all."
              : "From the router, eight seconds each way, with pings throughout: how much the round trip grows while the line is full is bufferbloat. A router's own test is capped by its processor: as fast as it can measure."}
        </Text>
        {tests.length > 0 && (
          <Table.ScrollContainer minWidth={520} type="native">
            <Table verticalSpacing={6} horizontalSpacing="md" withRowBorders={false}>
              <Table.Thead>
                <Table.Tr>
                  {["When", "Down", "Up", "At rest", "Under load", "Bufferbloat"].map((h, i) => (
                    <Table.Th key={h} ta={i ? "right" : undefined}>
                      <Text span size="xs" c="dimmed" fw={500}>
                        {h}
                      </Text>
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {tests.slice(0, 5).map((t) => {
                  const bloat = bloatGrade(t);
                  const loaded = Math.max(t.downLoadedMs ?? 0, t.upLoadedMs ?? 0) || undefined;
                  return (
                    <Table.Tr key={t.at}>
                      <Table.Td>
                        <Text size="sm">{new Date(t.at).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={500}>
                          {mbit(t.downMbps)}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm" fw={500}>
                          {mbit(t.upMbps)}
                        </Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm">{ms(t.idleMs)}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        <Text size="sm">{ms(loaded)}</Text>
                      </Table.Td>
                      <Table.Td ta="right">
                        {bloat ? (
                          <ToneValue tone={toneOf.bloat(bloat.addedMs)}>
                            {bloat.grade} · +{bloat.addedMs} ms
                          </ToneValue>
                        ) : (
                          <Text size="sm">—</Text>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Stack>
    </Panel>
  );
};

/** Each DNS-over-HTTPS provider the router runs, answering or not; while the chosen one does not, dnsmasq asks the fallback. */
const dohWords = (intent: Intent, doh: { port: number; ok: boolean }[] | undefined): [string, { tone: Tone; text: string }][] => {
  const upstream = intent.dns.upstream;
  if (upstream.type !== "encrypted" || !doh) return [];
  const main = doh.find((d) => d.port === dohPorts.provider);
  const fallback = fallbackOf(upstream);
  const spare = doh.find((d) => d.port === dohPorts.fallback);
  return [
    [`${providerLabels[upstream.provider]} (encrypted)`, main ? (main.ok ? { tone: "good", text: "Answering" } : { tone: "poor", text: "Not answering" }) : { tone: "off", text: "—" }],
    ...(fallback
      ? [
          [
            `${providerLabels[fallback]}, if it does not`,
            !spare ? { tone: "off", text: "—" } : !spare.ok ? { tone: main?.ok ? "fair" : "poor", text: "Not answering" } : main?.ok ? { tone: "good", text: "Standing by" } : { tone: "fair", text: "In use" },
          ] as [string, { tone: Tone; text: string }],
        ]
      : []),
  ];
};

export const InternetStatusPage = () => {
  const navigate = useNavigate();
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus();
  const live = status.data;
  const range = useRangeSwitch().value;
  const latency = useSeries("latency");
  const gateway = useSeries("gateway");
  const loss = useSeries("loss");
  const down = useSeries("down");
  const up = useSeries("up");
  const internetPoints = useSeriesPoints("internet");
  const lastTest = useSpeedTests().data?.[0];
  const check = live?.internetCheck;
  const several = intent.internet.lines.length > 1;
  const lossNow = lately(loss);
  const carrying = live?.connections.find((c) => c.inUse);
  const main = live?.connections[0];
  const onBackup = several && main && !main.inUse && carrying && carrying !== main;
  const events = eventsAbout(live?.events, "line").map((e) => ({ at: e.at, text: e.text, tone: eventTone(e) }));
  const attention = (live?.attention ?? []).filter((a) => /^(internet|line|upnp|ipv6):/.test(a.id));
  const now = throughputNow(live);
  const tone: Tone = !live?.internet ? "off" : !live.internet.up ? "poor" : onBackup ? "fair" : worst(toneOf.latency(check?.latencyMs), toneOf.loss(lossNow));
  const headline = !live
    ? "Reading the router…"
    : !live.internet
      ? "The router did not answer"
      : !live.internet.up
        ? "No internet"
        : [
            onBackup ? `On ${carrying!.name}` : (carrying?.name ?? "Connected"),
            ms(check?.latencyMs),
            lossNow !== undefined ? `${percentWords(lossNow)} loss` : undefined,
            carrying?.uptime !== undefined ? `up ${duration(carrying.uptime)}` : undefined,
          ]
            .filter(Boolean)
            .join(" · ");
  const doh = dohWords(intent, check?.doh);
  const bloat = lastTest && bloatGrade(lastTest);
  return (
    <StatusPage
      title="Internet"
      live={liveLine(status)}
      actions={
        <>
          <RangeSwitch />
          <Button size="xs" variant="default" onClick={() => navigate("/settings/internet")}>
            Internet settings
          </Button>
        </>
      }
    >
      <Stack gap="sm">
        <Verdict
          tone={tone}
          detail={
            onBackup
              ? `${main!.name} is down${main!.line ? ` (${duration(main!.line.since)})` : ""}: ${carrying!.name} carries the traffic meanwhile.`
              : now.down !== undefined
                ? `↓ ${bitsWords(now.down)} · ↑ ${bitsWords(now.up)} now`
                : undefined
          }
        >
          {headline}
        </Verdict>
        {attention.length > 0 && <AttentionRows items={attention} />}
      </Stack>
      <Panel title={several ? "Lines" : "Line"} padded={false}>
        <div className="onc-rows">
        {intent.internet.lines.map((line) => {
          const c = live?.connections.find((x) => x.id === line.id);
          const state = lineState(c, several);
          const nat = natOf(c?.ipv4[0]);
          return (
            <Stack key={line.id} gap="sm" p="md">
              <Group justify="space-between" wrap="nowrap">
                <Text fw={600} size="sm">
                  {line.name || line.id}
                </Text>
                <ToneValue tone={state.tone}>
                  {state.word ?? "—"}
                  {state.since !== undefined ? ` · ${duration(state.since)}` : ""}
                </ToneValue>
              </Group>
              <Facts
                cols={{ base: 2, sm: 4 }}
                items={[
                  ["Address", c?.ipv4[0] ? <span key="a">{c.ipv4[0].split("/")[0]}{nat ? <Text span size="xs" c="dimmed"> · {nat}</Text> : null}</span> : undefined],
                  ["IPv6 prefix", c?.prefixes?.[0]],
                  ["Gateway", c?.gateway],
                  ["Connects by", c?.proto?.toUpperCase()],
                  ["Provider's DNS", c?.dns?.join(", ")],
                  ["Port", c?.device],
                  ["Shaped to", line.shaping ? `${line.shaping.down_mbps} / ${line.shaping.up_mbps} Mbit/s` : "Not shaped"],
                ]}
              />
            </Stack>
          );
        })}
        </div>
      </Panel>
      <Panel title="Up">
        <Stack gap="sm">
          {several &&
            intent.internet.lines.map((line) => <LineStrip key={line.id} id={line.id} name={line.name || line.id} range={range} />)}
          <Group gap="sm" wrap="nowrap">
            {several && (
              <Text size="xs" c="dimmed" w={90} style={{ flexShrink: 0 }}>
                Internet
              </Text>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <OutageStrip points={internetPoints} range={range} label="Internet up" />
            </div>
          </Group>
          <Text size="xs" c="dimmed">
            Grey: not read (the app was not running). Read every 10 seconds while someone looks, every minute otherwise.
          </Text>
        </Stack>
      </Panel>
      <Panel title="Round trip">
        <TimeChart
          label="Round trip"
          range={range}
          series={[
            { label: "To the internet (1.1.1.1)", points: latency },
            { label: "To the provider's router", points: gateway },
          ]}
          format={ms}
          bands={[
            { from: thresholds.latency.good, to: thresholds.latency.fair, tone: "fair" },
            { from: thresholds.latency.fair, tone: "poor" },
          ]}
          events={events}
          height={150}
        />
      </Panel>
      <SimpleGrid cols={{ base: 1, md: 2 }} spacing="lg">
        <Panel title="Loss">
          <TimeChart label="Loss" range={range} series={[{ label: "Loss", points: loss }]} format={percentWords} max={5} events={events} height={110} />
        </Panel>
        <Panel title="Throughput">
          <TimeChart
            label="Throughput"
            range={range}
            series={[
              { label: "Down", points: down },
              { label: "Up", points: up },
            ]}
            format={(v) => bitsWords(v)}
            events={events}
            height={110}
          />
        </Panel>
      </SimpleGrid>
      <SpeedTestPanel />
      <Panel title="From the router">
        <Facts
          cols={{ base: 1, sm: 2 }}
          items={[
            [
              "Address the internet sees",
              check?.publicIpv4 ? (
                <span key="p">
                  {check.publicIpv4}
                  {carrying?.ipv4[0] && carrying.ipv4[0].split("/")[0] !== check.publicIpv4 ? (
                    <Text span size="xs" c="dimmed">
                      {" "}
                      · not the line's own: another NAT sits before the router
                    </Text>
                  ) : null}
                </span>
              ) : undefined,
            ],
            ["Jitter", check?.jitterMs !== undefined ? <ToneValue key="j" tone={toneOf.jitter(check.jitterMs)}>{ms(check.jitterMs)}</ToneValue> : undefined],
            ["Name lookups (the router's DNS)", check ? <ToneValue key="d" tone={check.dnsOk ? "good" : "poor"}>{check.dnsOk ? "Answering" : "Not answering"}</ToneValue> : undefined],
            ...doh.map(([label, state]): [string, React.ReactNode] => [label, <ToneValue key={label} tone={state.tone}>{state.text}</ToneValue>]),
            [
              "Smart queueing",
              check?.queues.length ? (
                <span key="q">
                  On {check.queues.map((q) => q.device).join(", ")}
                  {bloat ? <Text span size="xs" c="dimmed"> · +{bloat.addedMs} ms under load at the last test</Text> : null}
                </span>
              ) : (
                "Off"
              ),
            ],
          ]}
        />
      </Panel>
    </StatusPage>
  );
};

const LineStrip = ({ id, name, range }: { id: string; name: string; range: "day" | "month" }) => (
  <Group gap="sm" wrap="nowrap">
    <Text size="xs" c="dimmed" w={90} truncate style={{ flexShrink: 0 }}>
      {name}
    </Text>
    <div style={{ flex: 1, minWidth: 0 }}>
      <OutageStrip points={useSeriesPoints(`line:${id}`)} range={range} label={`${name} up`} />
    </div>
  </Group>
);
