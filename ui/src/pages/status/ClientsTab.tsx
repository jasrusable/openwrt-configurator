// Status › Clients: every device on the network, how it is connected and
// where, from the router's leases and neighbours and each access point's
// Wi-Fi clients. One click gives one a fixed address (a draft edit).
import { Badge, Button, Group, Select, Stack, Text, TextInput } from "@mantine/core";
import { IconDevices, IconPlugConnected, IconSearch, IconWifi } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { Intent } from "../../../../src/intent/schema";
import type { ClientView } from "../../../../src/status/views";
import { useNetworkStatus } from "../../data/status";
import { duration } from "../../facts";
import { useDraft, useDraftValue } from "../../form/draft";
import { EmptyState, ItemIcon, Section, SettingRow, SettingsPage } from "../../kit/layout";
import { liveLine, signalWords } from "./shared";

const how = (c: ClientView) =>
  c.connection.kind === "wifi"
    ? [
        `Wi-Fi${c.connection.band ? ` ${c.connection.band}` : ""}${c.connection.ssid ? ` · ${c.connection.ssid}` : ""} on ${c.connection.accessPoint}`,
        c.connection.signal !== undefined ? `${signalWords(c.connection.signal)} signal (${c.connection.signal} dBm)` : undefined,
        c.connection.connected !== undefined ? `for ${duration(c.connection.connected)}` : undefined,
      ]
        .filter(Boolean)
        .join(", ")
    : c.connection.kind === "wired"
      ? "Cable"
      : "Not seen lately";

const stateBadge = { online: ["Online", "green"], recent: ["Seen lately", "gray"], away: ["Away", "gray"] } as const;

const ClientRow = ({ client }: { client: ClientView }) => {
  const draft = useDraft();
  const navigate = useNavigate();
  const intent: Intent = useDraftValue();
  const network = intent.networks.findIndex((n) => n.name === client.network);
  // A fixed address: its current one, under its name, in the draft (Save shows it).
  const reserve = () => {
    const n = intent.networks[network];
    const name = (client.name ?? `device-${client.mac.slice(-5).replace(":", "")}`).toLowerCase().replace(/[^a-z0-9-]/g, "-");
    draft.set(`networks.${network}.reservations` as never, [...n.reservations, { name, mac: client.mac, address: client.ipv4! }] as never);
    navigate(`/networks/${network}`);
  };
  const [label, color] = stateBadge[client.state];
  return (
    <SettingRow
      label={
        <Group gap={10} wrap="nowrap">
          <ItemIcon icon={client.connection.kind === "wifi" ? IconWifi : client.connection.kind === "wired" ? IconPlugConnected : IconDevices} color="blue" off={client.state !== "online"} />
          <Stack gap={0}>
            <Text size="sm" fw={500}>
              {client.name ?? client.mac}
            </Text>
            <Text size="xs" c="dimmed">
              {[client.ipv4, client.network, how(client)].filter(Boolean).join(" · ")}
            </Text>
          </Stack>
        </Group>
      }
    >
      <Group gap="xs" wrap="nowrap">
        {client.reserved ? (
          <Badge variant="light" color="gray" radius="sm" style={{ textTransform: "none" }}>
            Fixed address
          </Badge>
        ) : (
          client.ipv4 &&
          network >= 0 && (
            <Button size="compact-xs" variant="subtle" color="gray" onClick={reserve}>
              Reserve address
            </Button>
          )
        )}
        <Badge variant="light" color={color} radius="sm" style={{ textTransform: "none" }}>
          {label}
        </Badge>
      </Group>
    </SettingRow>
  );
};

export const ClientsTab = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("clients");
  const [search, setSearch] = useState("");
  const [network, setNetwork] = useState<string | null>(null);
  const all = status.data?.clientList ?? [];
  const term = search.trim().toLowerCase();
  const shown = all.filter(
    (c) =>
      (!network || c.network === network) &&
      (!term || [c.name, c.mac, c.ipv4, ...c.ipv6, c.connection.kind === "wifi" ? c.connection.accessPoint : ""].some((v) => v?.toLowerCase().includes(term)))
  );
  const online = all.filter((c) => c.state === "online").length;
  return (
    <SettingsPage
      title="Clients"
      description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}
    >
      <Group gap="sm">
        <TextInput placeholder="Name, address or MAC" leftSection={<IconSearch size={14} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} w={260} />
        <Select placeholder="Every network" clearable data={intent.networks.map((n) => n.name)} value={network} onChange={setNetwork} w={200} />
      </Group>
      <Section title={`${online} online · ${all.length} known`}>
        {shown.length === 0 ? (
          <EmptyState icon={IconDevices}>{status.data ? "No devices match." : "Reading the network…"}</EmptyState>
        ) : (
          shown.map((c) => <ClientRow key={c.mac} client={c} />)
        )}
      </Section>
    </SettingsPage>
  );
};
