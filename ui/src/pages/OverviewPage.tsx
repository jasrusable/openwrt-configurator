// Status › Overview: the network at a glance. Your settings, what each device
// is (facts), and what the network is doing now (status, read from the
// devices every 30 seconds while this page is open), interpreted against the
// settings: what does not match them is shown, never hidden.
import { Button, Group, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { ReactNode } from "react";
import { useNavigate } from "react-router";
import { Intent } from "../../../src/intent/schema";
import { internetIpv6 } from "../../../src/intent/connections";
import { templateOf } from "../../../src/intent/networkTemplates";
import { useFreshDevices } from "../data/devices";
import { useProvision } from "../data/provision";
import { useNetworkStatus } from "../data/status";
import { ago, duration, modelOf, portsOf, routerFacts } from "../facts";
import { useDraftValue } from "../form/draft";
import { Section, SettingRow, SettingsPage, StatusDot } from "../kit/layout";
import { applyStatus } from "../provision/status";

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
      {apply && (
        <Section title="Devices and settings">
          <SettingRow label={apply.title} description={apply.detail}>
            <Link to="/apply">Apply</Link>
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
