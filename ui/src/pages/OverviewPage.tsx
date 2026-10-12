// Status › Overview: the network at a glance. Your settings, what each device
// is (facts), and what the network is doing now (status, read from the
// devices every 30 seconds while this page is open), interpreted against the
// settings: what does not match them is shown, never hidden.
import { meshMtu } from "../../../src/intent/features/mesh";
import { where } from "../../../src/intent/places";
import { weakMeshLinkMbps } from "../../../src/status/network";
import { Anchor, Button, Group, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { internetIpv6 } from "../../../src/intent/connections";
import { templateOf } from "../../../src/intent/networkTemplates";
import { useFreshDevices } from "../data/devices";
import { useProvision } from "../data/provision";
import { useNetworkStatus } from "../data/status";
import { useMeasureLink } from "../data/mesh";
import { ago, duration, modelOf, portsOf, routerFacts } from "../facts";
import { useDraftValue } from "../form/draft";
import { Section, SettingRow, SettingsPage, StatusDot } from "../kit/layout";
import { applyStatus } from "../provision/status";
import { AttentionSection } from "./status/shared";

const connections: Record<string, string> = { dhcp: "DHCP", pppoe: "PPPoE", static: "Static IP" };
const providers: Record<string, string> = { cloudflare: "Cloudflare", google: "Google", quad9: "Quad9" };
const types: Record<string, string> = { home: "Home", guest: "Guest", iot: "IoT", custom: "Custom" };

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
  const several = intent.internet.connections.length > 1;
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
      description={
        live
          ? `${intent.site.name} · live, read from the devices ${ago(status.dataUpdatedAt)}`
          : status.isFetching
          ? `${intent.site.name} · reading the devices…`
          : intent.site.name
      }
    >
      <AttentionSection items={live?.attention} />
      {apply && (
        <Section title="Devices and settings">
          <SettingRow label={apply.title} description={apply.detail}>
            <Link to="?apply">Apply</Link>
          </SettingRow>
        </Section>
      )}

      <Section title="Internet" description={onBackup}>
        {intent.internet.connections.map((c) => {
          const now = live?.connections.find((x) => x.id === c.id);
          const port = c.port ?? wan;
          // With several, mwan3 says whether the line works; else its interface.
          const works = now?.line ? ["online", "disconnecting"].includes(now.line.state) : now?.up;
          const since = now?.line?.since ?? (now?.up ? now.uptime : undefined);
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
              <State up={now ? (now.inUse ? true : works ? undefined : false) : undefined}>
                {!now
                  ? connections[c.connection.type]
                  : now.inUse
                    ? several ? "In use" : "Connected"
                    : works
                      ? "Standby"
                      : now.line?.state === "connecting"
                        ? "Coming back"
                        : "Down"}
              </State>
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
        {live && (
          <SettingRow label="Connected devices" description={`${live.clients.wifi} on Wi-Fi`}>
            <State>{devicesWord(live.clients.total)}</State>
          </SettingRow>
        )}
      </Section>

      <Section title="Devices">
        {intent.hardware.map((device) => {
          const known = facts?.[device.name];
          const now = live?.devices.find((d) => d.name === device.name);
          const what = known ? `${modelOf(known.schema)} · OpenWrt ${known.schema.version}` : undefined;
          const health = now?.health
            ? `up ${duration(now.health.uptime)} · load ${now.health.load.toFixed(2)} · memory ${Math.round(now.health.memoryUsed * 100)}%`
            : now?.error
            ? `not reached: ${now.error}`
            : devices.reading
            ? "reading…"
            : undefined;
          return (
            <SettingRow key={device.name} label={device.name} description={[what, health].filter(Boolean).join(" · ")}>
              <State up={now ? !!now.health : undefined}>{device.role === "router" ? "Router" : "Access point"}</State>
            </SettingRow>
          );
        })}
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
              const best = Math.max(0, ...links.map((l) => l.throughput));
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
                  <State up={links.length ? best >= weakMeshLinkMbps && !node?.fragmentsOverCable && !node?.dropsLargeFrames : false}>
                    {node?.dropsLargeFrames
                      ? "Cable drops large packets"
                      : links.length
                      ? best < weakMeshLinkMbps
                        ? "Weak link"
                        : node?.fragmentsOverCable
                          ? "Linked, splitting over cable"
                          : "Linked"
                      : "No link"}
                  </State>
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
          ].map(({ name, since, kind }) => (
            <SettingRow
              key={`${kind}-${name}`}
              label={name}
              description={`${kind} · ${since === undefined ? "never connected" : since < 180 ? "connected" : `last seen ${duration(since)} ago`}`}
            >
              <State up={since !== undefined && since < 180 ? true : undefined}>
                {since !== undefined && since < 180 ? "Connected" : "Away"}
              </State>
            </SettingRow>
          ))}
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
              label={network.name}
              description={[network.subnet, types[templateOf(intent.networks, i)], now?.up === false ? "not up on the router" : undefined]
                .filter(Boolean)
                .join(" · ")}
            >
              <State up={now?.up}>{now ? devicesWord(now.clients) : ""}</State>
            </SettingRow>
          );
        })}
      </Section>

      <Section title="Wi-Fi">
        {intent.wifi.map((ssid) => {
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
