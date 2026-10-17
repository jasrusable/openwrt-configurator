// Overview: is everything all right, and if not, what? Its verdict first,
// with everything that needs you (from the devices, firmware, an apply
// waiting) and its fix; then a card each for the internet, the Wi-Fi, the
// devices and the clients, each opening its page; the network as it hangs
// together; and what happened lately. Each fact lives on its own page:
// this one only sums them up.
import { Anchor, Box, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { IconWorld } from "@tabler/icons-react";
import { useMediaQuery } from "@mantine/hooks";
import { useNavigate } from "react-router";
import type { Intent } from "../../../../src/intent/schema";
import { clientHealth, needsLook, tone as toneOf, Tone, worst } from "../../../../src/status/health";
import type { NetworkStatus } from "../../../../src/status/network";
import type { Attention } from "../../../../src/status/views";
import { useUpdates } from "../../data/firmware";
import { useSeries, useSeriesPoints } from "../../data/history";
import { useProvision } from "../../data/provision";
import { eventTone, throughputNow, useNetworkStatus } from "../../data/status";
import { useDraftValue } from "../../form/draft";
import { bitsWords, bytes } from "../../kit/format";
import { OutageStrip } from "../../kit/OutageStrip";
import { useChartRange } from "../../data/history";
import { ms, Panel, StatusPage, SummaryCard, ToneDot, Verdict } from "../../kit/status";
import { applyStatus } from "../../provision/status";
import { AttentionRows, clientName, eventTime, lately, lineState, liveLine, roleIcon, subjectLink, ThingIcon } from "./shared";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Everything that needs you: the devices' own (the server's), then a newer OpenWrt and an apply waiting or running. */
const useAttention = (live: NetworkStatus | undefined): Attention[] => {
  const updates = useUpdates();
  const provision = useProvision().data;
  const apply = provision && applyStatus(provision);
  return [
    ...(live?.attention ?? []),
    ...(updates
      ? [{ id: "firmware", severity: "info" as const, title: `OpenWrt ${updates.version} is out`, detail: `${plural(updates.devices.length, "device")} can update.`, link: "/settings/system/firmware" }]
      : []),
    // Saved but not applied comes from the server; this is the rest an apply can be.
    ...(apply && provision && (provision.state === "running" || provision.live === "none")
      ? [{ id: "apply:state", severity: "info" as const, title: apply.title, detail: apply.detail, link: "?apply" }]
      : []),
  ];
};

const InternetCard = ({ live }: { live?: NetworkStatus }) => {
  const navigate = useNavigate();
  const loss = lately(useSeries("loss"));
  const points = useSeriesPoints("internet");
  const range = useChartRange();
  const check = live?.internetCheck;
  const now = throughputNow(live);
  const carrying = live?.connections.find((c) => c.inUse);
  const several = (live?.connections.length ?? 0) > 1;
  const state = lineState(carrying ?? live?.connections[0], several);
  const tone: Tone = !live?.internet ? "off" : !live.internet.up ? "poor" : worst(toneOf.latency(check?.latencyMs), toneOf.loss(loss));
  return (
    <SummaryCard
      title="Internet"
      tone={tone}
      onOpen={() => navigate("/internet")}
      headline={!live?.internet ? "—" : live.internet.up ? (carrying?.name ?? "Connected") : "Down"}
      lines={[
        live?.internet?.up && [ms(check?.latencyMs), loss !== undefined ? `${Math.round(loss * 10) / 10}% loss` : undefined, several && state.word].filter(Boolean).join(" · "),
        now.down !== undefined ? `↓ ${bitsWords(now.down)} · ↑ ${bitsWords(now.up)}` : undefined,
      ]}
    >
      <Box mt={6}>
        <OutageStrip points={points} range={range} label="Internet up" />
      </Box>
    </SummaryCard>
  );
};

const WifiCard = ({ live }: { live?: NetworkStatus }) => {
  const navigate = useNavigate();
  const radios = live?.radios ?? [];
  const onWifi = (live?.clientList ?? []).filter((c) => c.state === "online" && c.connection.kind === "wifi");
  const poor = onWifi.filter((c) => needsLook(clientHealth(c, radios))).length;
  const busiest = radios.filter((r) => r.busy !== undefined).sort((a, b) => b.busy! - a.busy!)[0];
  const offAir = (live?.attention ?? []).some((a) => a.id.startsWith("ssid:"));
  const tone: Tone = !live ? "off" : offAir ? "poor" : worst(poor ? "fair" : "good", toneOf.busy(busiest?.busy) === "poor" ? "fair" : "good");
  return (
    <SummaryCard
      title="Wi-Fi"
      tone={tone}
      onOpen={() => navigate("/wifi")}
      headline={live ? `${onWifi.length} on Wi-Fi` : "—"}
      lines={[
        live && (poor ? `${plural(poor, "client")} could be better served` : "Every client served well"),
        busiest && `Busiest: ${busiest.accessPoint} · ${busiest.band} · ${busiest.busy}%`,
      ]}
    />
  );
};

const DevicesCard = ({ live }: { live?: NetworkStatus }) => {
  const navigate = useNavigate();
  const updates = useUpdates();
  const views = live?.deviceViews ?? [];
  const reached = views.filter((d) => d.reachable).length;
  const warmest = Math.max(-Infinity, ...views.flatMap((d) => (d.temperature !== undefined ? [d.temperature] : [])));
  const warned = (live?.attention ?? []).some((a) => /^(storage|temperature|memory|service|unread):/.test(a.id));
  const tone: Tone = !live ? "off" : reached < views.length ? "poor" : warned ? "fair" : "good";
  return (
    <SummaryCard
      title="Devices"
      tone={tone}
      onOpen={() => navigate("/devices")}
      headline={live ? `${reached} of ${views.length} up` : "—"}
      lines={[Number.isFinite(warmest) && `Warmest ${Math.round(warmest)} °C`, updates && `${plural(updates.devices.length, "device")} can update`]}
    />
  );
};

const ClientsCard = ({ live }: { live?: NetworkStatus }) => {
  const navigate = useNavigate();
  const all = live?.clientList ?? [];
  const online = all.filter((c) => c.state === "online");
  const fresh = all.filter((c) => c.new).length;
  const monthly = online.filter((c) => c.traffic?.over === "month");
  const top = [...monthly].sort((a, b) => b.traffic!.down + b.traffic!.up - (a.traffic!.down + a.traffic!.up))[0];
  return (
    <SummaryCard
      title="Clients"
      tone={live ? "good" : "off"}
      onOpen={() => navigate("/clients")}
      headline={live ? `${online.length} online` : "—"}
      lines={[live && (fresh ? `${plural(fresh, "new device")} today` : "No new devices today"), top && `Most this month: ${clientName(top)} · ${bytes(top.traffic!.down + top.traffic!.up)}`]}
    />
  );
};

/** One box of the map: what it is, its name, its state, a line under it; opening its page. */
const Node = ({ icon, name, sub, tone, onOpen }: { icon: typeof IconWorld; name: string; sub?: string; tone: Tone; onOpen?: () => void }) => (
  <Box
    className={`onc-card${onOpen ? " onc-link-card" : ""}`}
    px="sm"
    py={8}
    role={onOpen ? "link" : undefined}
    tabIndex={onOpen ? 0 : undefined}
    onClick={onOpen}
    onKeyDown={(e) => onOpen && e.key === "Enter" && onOpen()}
    style={{ display: "inline-flex", maxWidth: "100%" }}
  >
    <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
      <ThingIcon icon={icon} away={tone === "poor"} />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={600} truncate>
            {name}
          </Text>
          <ToneDot tone={tone} />
        </Group>
        {sub && (
          <Text size="xs" c="dimmed" truncate>
            {sub}
          </Text>
        )}
      </Stack>
    </Group>
  </Box>
);

/** A link of the map, drawn between two rows: its kind and, for the mesh, how fast it measures. */
const Wire = ({ label, tone = "off" }: { label?: string; tone?: Tone }) => (
  <Stack gap={0} align="center">
    <Box w={2} h={label ? 10 : 18} style={{ background: tone === "poor" ? "var(--mantine-color-red-6)" : "var(--onc-separator)" }} />
    {/* Stacked in one column (a phone), a label between two nodes would seem to link them: each node names its own uplink there. */}
    {label && (
      <Text size="10px" c="dimmed" lh={1.3} visibleFrom="xs">
        {label}
      </Text>
    )}
    {label && <Box w={2} h={10} style={{ background: "var(--onc-separator)" }} />}
  </Stack>
);

/**
 * The network as it hangs together: the internet, the router, and each
 * access point by how it reaches the router (a cable, or the mesh and how
 * fast it measures). Switches between cannot be seen, so none are drawn.
 */
const Topology = ({ intent, live }: { intent: Intent; live?: NetworkStatus }) => {
  const navigate = useNavigate();
  const clients = (live?.clientList ?? []).filter((c) => c.state === "online");
  const onWifi = (name: string) => clients.filter((c) => c.connection.kind === "wifi" && c.connection.accessPoint === name).length;
  const view = (name: string) => live?.deviceViews?.find((d) => d.name === name);
  const toneOfDevice = (name: string): Tone => (!live ? "off" : view(name)?.rebooting ? "fair" : view(name)?.reachable ? "good" : "poor");
  const open = (name: string) => () => navigate(`/devices/${encodeURIComponent(name)}`);
  const router = intent.hardware.find((d) => d.role === "router");
  const aps = intent.hardware.filter((d) => d.role !== "router");
  const internetTone: Tone = !live?.internet ? "off" : live.internet.up ? "good" : "poor";
  const phone = useMediaQuery("(max-width: 36em)");
  return (
    <Panel title="Network">
      <Stack gap={0} align="center">
        <Node icon={IconWorld} name="Internet" tone={internetTone} sub={live?.connections.find((c) => c.inUse)?.name} onOpen={() => navigate("/internet")} />
        {router && (
          <>
            <Wire tone={internetTone} />
            <Node icon={roleIcon("router")} name={router.name} tone={toneOfDevice(router.name)} sub={onWifi(router.name) ? `${onWifi(router.name)} on Wi-Fi` : "Router"} onOpen={open(router.name)} />
          </>
        )}
        {aps.length > 0 && <Wire />}
        {aps.length > 0 && (
          <Box w="100%" pos="relative">
          {/* The bar the access points hang from: from the first column's middle to the last's. */}
          {aps.length > 1 && <Box pos="absolute" top={0} h={2} visibleFrom="xs" style={{ left: `${50 / Math.min(aps.length, 3)}%`, right: `${50 / Math.min(aps.length, 3)}%`, background: "var(--onc-separator)" }} />}
          <SimpleGrid cols={{ base: 1, xs: Math.min(aps.length, 3) }} spacing={0} w="100%">
            {aps.map((ap) => {
              const links = live?.mesh?.find((m) => m.name === ap.name)?.links ?? [];
              const best = Math.max(0, ...links.map((l) => l.throughput));
              const label = ap.uplink === "mesh" ? (best ? `mesh ~${Math.round(best)} Mbit/s` : "mesh: no link") : "cable";
              const linkTone: Tone = ap.uplink === "mesh" ? (best ? (best < 20 ? "fair" : "good") : live ? "poor" : "off") : "off";
              return (
                <Stack key={ap.name} gap={0} align="center" style={{ minWidth: 0 }}>
                  <Wire label={label} tone={linkTone} />
                  <Node icon={roleIcon(ap.role)} name={ap.name} tone={toneOfDevice(ap.name)} sub={`${onWifi(ap.name)} on Wi-Fi${phone ? ` · ${label}` : ""}`} onOpen={open(ap.name)} />
                </Stack>
              );
            })}
          </SimpleGrid>
          </Box>
        )}
      </Stack>
    </Panel>
  );
};

const RecentEvents = ({ live }: { live?: NetworkStatus }) => {
  const navigate = useNavigate();
  const events = [...(live?.events ?? [])].sort((a, b) => b.at - a.at).slice(0, 6);
  return (
    <Panel
      title="Recent events"
      padded={false}
      actions={
        <Anchor component="button" size="xs" onClick={() => navigate("/activity")}>
          All activity
        </Anchor>
      }
    >
      {events.length === 0 ? (
        <Text size="sm" c="dimmed" p="md">
          {live ? "Nothing has happened since the app started watching." : "Reading…"}
        </Text>
      ) : (
        events.map((e, i) => (
          <button key={`${e.at}-${i}`} type="button" className="onc-list-row" onClick={() => navigate(subjectLink(e))}>
            <Text size="xs" c="dimmed" w={70} style={{ flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
              {eventTime(e.at)}
            </Text>
            <ToneDot tone={eventTone(e)} />
            <Text size="sm" style={{ flex: 1, minWidth: 0 }} truncate>
              {e.text}
            </Text>
          </button>
        ))
      )}
    </Panel>
  );
};

export const OverviewPage = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus();
  const live = status.data;
  const attention = useAttention(live);
  const problems = attention.filter((a) => a.severity === "problem").length;
  const warnings = attention.filter((a) => a.severity === "warning").length;
  const views = live?.deviceViews ?? [];
  const online = (live?.clientList ?? []).filter((c) => c.state === "online").length;
  const loss = lately(useSeries("loss"));
  const summary = live
    ? [
        live.internet ? (live.internet.up ? `internet ${ms(live.internetCheck?.latencyMs)}${loss !== undefined ? `, ${Math.round(loss * 10) / 10}% loss` : ""}` : "no internet") : "router not read",
        `${views.filter((d) => d.reachable).length} of ${plural(views.length, "device")} up`,
        `${online} online`,
      ].join(" · ")
    : undefined;
  return (
    <StatusPage title="Overview" live={liveLine(status)}>
      <Stack gap="sm">
        <Verdict
          tone={!live ? "off" : problems ? "poor" : warnings ? "fair" : "good"}
          detail={summary}
        >
          {!live ? "Reading the network…" : problems ? `${plural(problems, "problem")}${warnings ? ` and ${plural(warnings, "warning")}` : ""}` : warnings ? `${plural(warnings, "thing")} to look at` : "All good"}
        </Verdict>
        {attention.length > 0 && <AttentionRows items={attention} />}
      </Stack>
      <SimpleGrid cols={{ base: 1, xs: 2, md: 4 }} spacing="sm">
        <InternetCard live={live} />
        <WifiCard live={live} />
        <DevicesCard live={live} />
        <ClientsCard live={live} />
      </SimpleGrid>
      <Topology intent={intent} live={live} />
      <RecentEvents live={live} />
    </StatusPage>
  );
};
