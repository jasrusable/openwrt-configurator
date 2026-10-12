// Status › Overview: the network at a glance. For now what the app knows for
// sure: your settings, each device's facts as last read, and where the
// devices stand against the saved settings. Live status (clients, traffic,
// health) arrives with the read-only monitor (CLAUDE.md, "Reading devices").
import { Button, Text } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { ReactNode } from "react";
import { useNavigate } from "react-router";
import { templateOf } from "../../../src/intent/networkTemplates";
import { Intent } from "../../../src/intent/schema";
import { useDeviceFacts } from "../data/devices";
import { useProvision } from "../data/provision";
import { ago, modelOf, portsOf, routerFacts } from "../facts";
import { useDraftValue } from "../form/draft";
import { Section, SettingRow, SettingsPage } from "../kit/layout";
import { applyStatus } from "../provision/status";

const connections: Record<string, string> = { dhcp: "DHCP", pppoe: "PPPoE", static: "Static IP" };
const providers: Record<string, string> = { cloudflare: "Cloudflare", google: "Google", quad9: "Quad9" };
const types: Record<string, string> = { home: "Home", guest: "Guest", iot: "IoT", custom: "Custom" };

/** A row that leads to where it is set. */
const Link = ({ to, children }: { to: string; children: ReactNode }) => {
  const navigate = useNavigate();
  return (
    <Button variant="subtle" color="gray" size="compact-sm" rightSection={<IconChevronRight size={14} />} onClick={() => navigate(to)}>
      {children}
    </Button>
  );
};

const Dim = ({ children }: { children: ReactNode }) => (
  <Text size="sm" c="dimmed" ta="right">
    {children}
  </Text>
);

export const OverviewPage = () => {
  const intent: Intent = useDraftValue();
  const facts = useDeviceFacts().data;
  const provision = useProvision().data;
  const status = provision && applyStatus(provision);
  const router = routerFacts(intent, facts);
  const wan = router && portsOf(router.schema).wan[0];
  const dns = intent.dns.upstream;
  return (
    <SettingsPage title="Overview" description={intent.site.name}>
      {status && (
        <Section title="Devices and settings">
          <SettingRow label={status.title} description={status.detail}>
            <Link to="/apply">Apply</Link>
          </SettingRow>
        </Section>
      )}

      <Section title="Internet">
        <SettingRow
          label="Connection"
          description={wan && router ? `On ${wan} of ${router.name} (${modelOf(router.schema)})` : undefined}
        >
          <Dim>{connections[intent.internet.connection.type]}</Dim>
        </SettingRow>
        <SettingRow label="IPv6">
          <Dim>{intent.internet.ipv6 ? "On" : "Off"}</Dim>
        </SettingRow>
        <SettingRow label="DNS">
          <Dim>
            {dns.type === "encrypted"
              ? `Encrypted · ${providers[dns.provider]}`
              : dns.type === "custom"
              ? dns.servers.join(", ")
              : "Your provider's"}
          </Dim>
        </SettingRow>
      </Section>

      <Section title="Devices">
        {intent.hardware.map((device) => {
          const known = facts?.[device.name];
          return (
            <SettingRow
              key={device.name}
              label={device.name}
              description={
                known
                  ? `${modelOf(known.schema)} · OpenWrt ${known.schema.version} · read ${ago(known.readAt)}`
                  : "Not read yet"
              }
            >
              <Dim>{device.role === "router" ? "Router" : "Access point"}</Dim>
            </SettingRow>
          );
        })}
      </Section>

      <Section title="Networks">
        {intent.networks.map((network, i) => (
          <SettingRow key={network.id} label={network.name} description={network.subnet}>
            <Dim>{types[templateOf(intent.networks, i)]}</Dim>
          </SettingRow>
        ))}
      </Section>

      <Section title="Wi-Fi">
        {intent.wifi.map((ssid) => (
          <SettingRow
            key={ssid.ssid}
            label={ssid.ssid || "Unnamed"}
            description={intent.networks.find((n) => n.id === ssid.network)?.name}
          >
            <Dim>{ssid.enabled === false ? "Off" : "On"}</Dim>
          </SettingRow>
        ))}
      </Section>
    </SettingsPage>
  );
};
