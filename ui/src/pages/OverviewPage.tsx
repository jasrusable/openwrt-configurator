// Status › Overview: the network at a glance. Your settings, what each device
// is (facts), and what the network is doing now (status, read from the
// devices every 30 seconds while this page is open), interpreted against the
// settings: what does not match them is shown, never hidden.
import { meshMtu } from "../../../src/intent/features/mesh";
import { where } from "../../../src/intent/places";
import { meshNodeState, peerState } from "../../../src/status/views";
import { Anchor, Box, Button, Group, SimpleGrid, Stack, Text } from "@mantine/core";
import { IconAccessPoint, IconChevronRight, IconRouter, IconWorld } from "@tabler/icons-react";
import { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { internetIpv6 } from "../../../src/intent/connections";
import { templateOf } from "../../../src/intent/networkTemplates";
import { useFreshDevices } from "../data/devices";
import { useProvision } from "../data/provision";
import { useSeries } from "../data/history";
import { bitsWords } from "../kit/format";
import { throughputNow, useNetworkStatus } from "../data/status";
import { useMeasureLink } from "../data/mesh";
import { duration, portsOf, routerFacts } from "../facts";
import { useDraftValue } from "../form/draft";
import { AreaChart, Tile } from "../kit/charts";
import { ItemIcon, Section, SettingRow, SettingsPage, StatusDot } from "../kit/layout";
import { applyStatus } from "../provision/status";
import { AttentionSection, lineState, liveLine } from "./status/shared";
import { bandLabels, lineTypeLabels, networkTypeLabels, shownName } from "../../../src/intent/labels";

const providers: Record<string, string> = { cloudflare: "Cloudflare", google: "Google", quad9: "Quad9" };

const Link = ({ to, children }: { to: string; children: ReactNode }) => {
  const navigate = useNavigate();
  return (
    <Button variant="subtle" color="gray" size="compact-sm" rightSection={<IconChevronRight size={14} />} onClick={() => navigate(to)}>
      {children}
    </Button>
  );
};

/** A value, with a dot when its state is known: green up, red down. */
const State = ({ up, children }: { up?: boolean; children: ReactNode }) => (
  <Group gap={6} wrap="nowrap" justify="flex-end">
    {up !== undefined && <StatusDot color={up ? "green" : "red"} />}
    <Text size="sm" c="dimmed" ta="right">
      {children}
    </Text>
  </Group>
);

/** A mesh link, its quality, and its measured speed on request (sends test traffic for a few seconds). */
const LinkSpeed = ({ from, to, throughput }: { from: string; to: string; throughput: number }) => {
  const measure = useMeasureLink();
  return (
    <Text component="span" size="xs" c="dimmed">
      {to} · ~{Math.round(throughput)} Mbit/s ·{" "}
      {measure.data ? (
        `${Math.round(measure.data.mbps)} Mbit/s`
      ) : measure.isError ? (
        (measure.error as Error).message
      ) : (
        <Anchor component="button" size="xs" onClick={() => measure.mutate({ from, to })} disabled={measure.isPending}>
          {measure.isPending ? "Measuring…" : "Test speed"}
        </Anchor>
      )}
    </Text>
  );
};

const devicesWord = (n: number) => `${n} device${n === 1 ? "" : "s"}`;

/** One box of the topology: what it is, its name, and a line about it. */
const Node = ({ icon, name, sub, up }: { icon: typeof IconRouter; name: string; sub?: string; up?: boolean }) => (
  <Box className="onc-card" px="sm" py={8} style={{ display: "inline-flex", maxWidth: "100%" }}>
    <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
      <ItemIcon icon={icon} color={up === false ? "red" : "teal"} off={up === undefined} />
      <Stack gap={0} style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Text size="sm" fw={600} truncate>
            {name}
          </Text>
          {up !== undefined && <StatusDot color={up ? "green" : "red"} />}
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

const Wire = () => <Box w={2} h={18} mx="auto" style={{ background: "var(--onc-separator)" }} />;

/** The network as it hangs together now: the internet, the router, each access point and who is on it. */
const Topology = ({ intent }: { intent: Intent }) => {
  const live = useNetworkStatus().data;
  const now = throughputNow(live);
  const clients = live?.clientList?.filter((c) => c.state === "online") ?? [];
  const onWifi = (name: string) => clients.filter((c) => c.connection.kind === "wifi" && c.connection.accessPoint === name).length;
  const reached = (name: string) => (live ? !!live.devices.find((d) => d.name === name)?.health : undefined);
  const router = intent.hardware.find((d) => d.role === "router");
  const aps = intent.hardware.filter((d) => d.role !== "router");
  const routerWifi = router ? onWifi(router.name) : 0;
  return (
    <Box className="onc-card" p="md">
      <Stack gap={0} align="center">
        <Node
          icon={IconWorld}
          name="Internet"
          up={live?.internet?.up}
          sub={now.down !== undefined ? `↓ ${bitsWords(now.down)} · ↑ ${bitsWords(now.up)}` : undefined}
        />
        {router && (
          <>
            <Wire />
            <Node
              icon={IconRouter}
              name={router.name}
              up={reached(router.name)}
              sub={routerWifi ? `${routerWifi} on Wi-Fi` : "Router"}
            />
          </>
        )}
        {aps.length > 0 && (
          <>
            <Wire />
            {/* Several hang off one bar; one hangs off the router directly. */}
            <SimpleGrid
              cols={{ base: 1, xs: Math.min(aps.length, 3) }}
              spacing="sm"
              w="100%"
              style={aps.length > 1 ? { borderTop: "2px solid var(--onc-separator)", paddingTop: 14 } : undefined}
            >
              {aps.map((ap) => {
                const mesh = live?.mesh?.find((m) => m.name === ap.name);
                const best = Math.max(0, ...(mesh?.links ?? []).map((l) => l.throughput));
                const link = ap.uplink === "mesh" ? (best ? `Mesh ~${Math.round(best)} Mbit/s` : "Mesh, no link") : "Cable";
                return (
                  <Box key={ap.name} style={{ display: "flex", justifyContent: "center", minWidth: 0 }}>
                    <Node icon={IconAccessPoint} name={ap.name} up={reached(ap.name)} sub={`${onWifi(ap.name)} on Wi-Fi · ${link}`} />
                  </Box>
                );
              })}
            </SimpleGrid>
          </>
        )}
      </Stack>
    </Box>
  );
};

/** The four numbers that say how the network is: internet, clients, devices, Wi-Fi. */
const Tiles = ({ intent }: { intent: Intent }) => {
  const live = useNetworkStatus().data;
  const now = throughputNow(live);
  const down = useSeries("down");
  const up = useSeries("up");
  const history = useSeries("clients");
  const online = live?.clientList?.filter((c) => c.state === "online") ?? [];
  const wifi = online.filter((c) => c.connection.kind === "wifi");
  const views = live?.deviceViews ?? [];
  const reachedCount = views.filter((d) => d.reachable).length;
  const hottest = Math.max(-Infinity, ...views.flatMap((d) => (d.temperature !== undefined ? [d.temperature] : [])));
  const onAir = live?.ssids.filter((s) => s.accessPoints.length > 0).length ?? 0;
  const bands = Object.values(bandLabels)
    .map((b) => [b, wifi.filter((c) => c.connection.kind === "wifi" && c.connection.band === b).length] as const)
    .filter(([, n]) => n);
  return (
    <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
      <Tile
        label="Internet"
        value={!live ? "—" : live.internet?.up ? "Online" : "Down"}
        color={!live ? undefined : live.internet?.up ? "green" : "red"}
        sub={now.down !== undefined ? `↓ ${bitsWords(now.down)} · ↑ ${bitsWords(now.up)}` : "Throughput after two reads"}
      >
        <AreaChart series={[down, up]} colors={["blue", "teal"]} height={28} />
      </Tile>
      <Tile label="Clients online" value={live ? online.length : "—"} color="cyan" sub={live ? `${wifi.length} on Wi-Fi` : undefined}>
        <AreaChart series={[history]} colors={["cyan"]} height={28} />
      </Tile>
      <Tile
        label="Devices"
        value={live ? `${reachedCount} of ${views.length}` : "—"}
        color={live ? (reachedCount === views.length ? "green" : "red") : undefined}
        sub={Number.isFinite(hottest) ? `Warmest ${Math.round(hottest)} °C` : live ? "answering" : undefined}
      />
      <Tile
        label="Wi-Fi"
        value={live ? `${onAir} network${onAir === 1 ? "" : "s"}` : "—"}
        color="blue"
        sub={bands.map(([b, n]) => `${n} on ${b}`).join(" · ") || (live ? "No one on Wi-Fi" : undefined)}
      />
    </SimpleGrid>
  );
};

export const OverviewPage = () => {
  const intent: Intent = useDraftValue();
  const devices = useFreshDevices();
  const facts = devices.data?.facts;
  const provision = useProvision().data;
  const status = useNetworkStatus();
  const live = status.data;
  const apply = provision && applyStatus(provision);
  const router = routerFacts(intent, facts);
  const wan = router && portsOf(router.schema).wan[0];
  const dns = intent.dns.upstream;
  const several = intent.internet.lines.length > 1;
  // On a backup: the main line is down and another carries the traffic.
  const main = live?.connections[0];
  const carrying = live?.connections.find((c) => c.inUse);
  const onBackup =
    several && main && !main.inUse && carrying
      ? `On ${carrying.name}${main.line ? ` · ${main.name} down ${duration(main.line.since)}` : ""}`
      : undefined;
  const unexpected = live && [...live.unexpected.interfaces, ...live.unexpected.ssids];
  return (
    <SettingsPage
      title="Overview"
      description={liveLine(intent.system.name, status)}
    >
      <AttentionSection items={live?.attention} />
      {/* Saved but not applied is in Needs attention; up to date says nothing. */}
      {apply && provision && (provision.state === "running" || provision.live === "none") && (
        <Section title="Devices and settings">
          <SettingRow label={apply.title} description={apply.detail}>
            <Link to="?apply">Apply</Link>
          </SettingRow>
        </Section>
      )}

      <Tiles intent={intent} />
      <Topology intent={intent} />

      <Section title="Internet" description={onBackup}>
        {intent.internet.lines.map((c) => {
          const now = live?.connections.find((x) => x.id === c.id);
          const port = c.port ?? wan;
          const { works, since, word, dot } = lineState(now, several);
          return (
            <SettingRow
              key={c.id}
              label={c.name || "Unnamed"}
              description={
                [
                  now?.ipv4[0],
                  port && router ? `on ${port} of ${router.name}` : undefined,
                  now && since !== undefined ? `${works ? "up" : "down"} ${duration(since)}` : undefined,
                ]
                  .filter(Boolean)
                  .join(" · ") || undefined
              }
            >
              <State up={dot}>{word ?? lineTypeLabels[c.type]}</State>
            </SettingRow>
          );
        })}
        <SettingRow label="IPv6" description={live?.internet?.ipv6[0]}>
          <State>{internetIpv6(intent) ? "On" : "Off"}</State>
        </SettingRow>
        <SettingRow label="DNS">
          <State>
            {dns.type === "encrypted"
              ? `Encrypted · ${providers[dns.provider]}`
              : dns.type === "custom"
              ? dns.servers.join(", ")
              : "Your provider's"}
          </State>
        </SettingRow>
      </Section>

      {live?.mesh && (
        <Section title="Mesh">
          {intent.hardware
            .filter(
              (d) =>
                d.uplink === "mesh" ||
                live.mesh!.some((m) => m.name === d.name && (m.links.length || m.fragmentsOverCable || m.dropsLargeFrames))
            )
            .map((d) => {
              const node = live.mesh!.find((m) => m.name === d.name);
              const links = node?.links ?? [];
              const state = meshNodeState(node);
              return (
                <SettingRow
                  key={d.name}
                  label={d.name}
                  description={
                    links.length ? (
                      <Group gap={10} component="span">
                        {links.map((l) => (
                          <LinkSpeed key={l.to} from={d.name} to={l.to} throughput={l.throughput} />
                        ))}
                      </Group>
                    ) : d.uplink === "mesh" ? (
                      "No mesh link: it cannot be reached but by cable"
                    ) : undefined
                  }
                  explain={
                    node?.dropsLargeFrames
                      ? `Something between this node and another (a switch) drops the mesh's ${meshMtu}-byte frames, so full-size packets over the cable are lost. Turn off ${where("mesh", "Larger frames over cable")}, or replace that switch.`
                      : node?.fragmentsOverCable
                        ? `A port here does not take ${meshMtu}-byte frames, so the mesh splits its packets over cable: slower. Another port, or a switch that takes them, fixes it.`
                        : undefined
                  }
                >
                  <State up={state.good}>{state.word}</State>
                </SettingRow>
              );
            })}
        </Section>
      )}

      {live?.vpn && (live.vpn.clients.length || live.vpn.sites.length || live.vpn.tunnels.length) ? (
        <Section title="VPN">
          {[
            ...live.vpn.clients.map((c) => ({ ...c, kind: "Remote client" })),
            ...live.vpn.sites.map((s) => ({ ...s, kind: "Linked site" })),
          ].map(({ name, since, kind }) => {
            const peer = peerState(since);
            return (
              <SettingRow
                key={`${kind}-${name}`}
                label={name}
                description={`${kind} · ${peer.detail ?? `last seen ${duration(since!)} ago`}`}
              >
                <State up={peer.connected || undefined}>{peer.word}</State>
              </SettingRow>
            );
          })}
          {live.vpn.tunnels.map((t) => (
            <SettingRow key={`tunnel-${t.name}`} label={t.name} description="VPN provider">
              <State up={t.up}>{t.up ? "Up" : "Down"}</State>
            </SettingRow>
          ))}
        </Section>
      ) : null}

      <Section title="Networks">
        {intent.networks.map((network, i) => {
          const now = live?.networks.find((n) => n.id === network.id);
          return (
            <SettingRow
              key={network.id}
              label={shownName(network.name)}
              description={[network.subnet, networkTypeLabels[templateOf(intent.networks, i)], now?.up === false ? "not up on the router" : undefined]
                .filter(Boolean)
                .join(" · ")}
            >
              <State up={now?.up}>{now ? devicesWord(now.clients) : ""}</State>
            </SettingRow>
          );
        })}
      </Section>

      <Section title="Wi-Fi">
        {intent.wifi.networks.map((ssid) => {
          const now = live?.ssids.find((s) => s.ssid === ssid.ssid);
          const on = now && now.accessPoints.length > 0;
          return (
            <SettingRow
              key={ssid.ssid}
              label={ssid.ssid || "Unnamed"}
              description={[
                intent.networks.find((n) => n.id === ssid.network)?.name,
                now ? (on ? `on ${now.accessPoints.join(", ")}` : "not broadcast") : undefined,
              ]
                .filter(Boolean)
                .join(" · ")}
            >
              <State up={now ? !!on : undefined}>
                {now ? devicesWord(now.clients) : ssid.enabled === false ? "Off" : "On"}
              </State>
            </SettingRow>
          );
        })}
      </Section>

      {unexpected && unexpected.length > 0 && (
        <Section
          title="Not in your settings"
          description="On the devices, but not something you have set up: applying your settings removes it."
        >
          {live!.unexpected.interfaces.map((id) => (
            <SettingRow key={`i-${id}`} label={id} description="An interface on the router" />
          ))}
          {live!.unexpected.ssids.map((ssid) => (
            <SettingRow key={`s-${ssid}`} label={ssid} description="An SSID an access point broadcasts" />
          ))}
        </Section>
      )}
    </SettingsPage>
  );
};
