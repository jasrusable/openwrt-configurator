// Clients: every device on the network, how it is connected and where, and
// how much it has used, from the router's leases, neighbours and traffic
// count and each access point's Wi-Fi clients. One click gives one a fixed
// address (a draft edit).
import { Badge, Button, Group, SegmentedControl, Select, SimpleGrid, Stack, Text, TextInput } from "@mantine/core";
import {
  IconBulb,
  IconCamera,
  IconDeviceDesktop,
  IconDeviceGamepad2,
  IconDeviceLaptop,
  IconDeviceMobile,
  IconDeviceSpeaker,
  IconDeviceTablet,
  IconDeviceTv,
  IconDeviceWatch,
  IconDevices,
  IconPrinter,
  IconSearch,
} from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import type { Intent } from "../../../../src/intent/schema";
import type { ClientView } from "../../../../src/status/views";
import { useSeries } from "../../data/history";
import { useNetworkStatus } from "../../data/status";
import { duration } from "../../facts";
import { useDraft, useDraftValue } from "../../form/draft";
import { AreaChart, SignalBars, Tile } from "../../kit/charts";
import { EmptyState, ItemIcon, Section, SettingRow, SettingsPage } from "../../kit/layout";
import { bytes, liveLine } from "./shared";

/** What a device probably is, from the name it gives: only for its icon. */
const kinds: [RegExp, typeof IconDevices, string][] = [
  [/iphone|pixel|galaxy|android|phone|oneplus|xiaomi|redmi|huawei|oppo|motorola/i, IconDeviceMobile, "blue"],
  [/ipad|tablet|kindle|\btab\b|-tab/i, IconDeviceTablet, "blue"],
  [/watch/i, IconDeviceWatch, "blue"],
  [/macbook|laptop|thinkpad|surface|notebook|xps|zenbook/i, IconDeviceLaptop, "indigo"],
  [/^mac$|imac|desktop|\bpc\b|-pc|workstation|mac-?mini|mac-?studio|nas|synology|server|raspberry|\brpi/i, IconDeviceDesktop, "indigo"],
  [/\btv\b|-tv|appletv|apple-tv|chromecast|roku|firetv|fire-tv|shield|bravia|webos|tizen/i, IconDeviceTv, "violet"],
  [/sonos|echo|homepod|speaker|beoplay|bose|marshall|nest-?(audio|mini)|google-?home/i, IconDeviceSpeaker, "violet"],
  // Brother printers name themselves BRW/BRN and their MAC.
  [/printer|epson|^br[wn][0-9a-f]{6}|canon|hp[a-f0-9]{6}|laserjet|officejet/i, IconPrinter, "gray"],
  [/cam|ring|doorbell|arlo|wyze/i, IconCamera, "orange"],
  [/playstation|ps[45]|xbox|switch|steam/i, IconDeviceGamepad2, "pink"],
  [/esp|tasmota|shelly|tuya|hue|wiz_|bulb|plug|light|lifx|tado|sensor|thermostat|roborock|vacuum|purifier|levoit|litter|robot|dyson/i, IconBulb, "yellow"],
];
const kindOf = (c: ClientView) => kinds.find(([re]) => re.test(c.name ?? "")) ?? ([undefined, IconDevices, "gray"] as const);

const how = (c: ClientView) =>
  c.connection.kind === "wifi"
    ? [
        c.connection.ssid,
        `on ${c.connection.accessPoint}`,
        c.connection.connected !== undefined ? `for ${duration(c.connection.connected)}` : undefined,
      ]
        .filter(Boolean)
        .join(" ")
    : c.connection.kind === "wired"
      ? "Cable"
      : "Not seen lately";

const bandColor = (band?: string) => (band === "6 GHz" ? "grape" : band === "5 GHz" ? "blue" : "teal");

const Chip = ({ color, children }: { color: string; children: React.ReactNode }) => (
  <Badge variant="light" color={color} radius="sm" size="sm" style={{ textTransform: "none" }}>
    {children}
  </Badge>
);

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
  const [, icon, color] = kindOf(client);
  const wifi = client.connection.kind === "wifi" ? client.connection : undefined;
  return (
    <SettingRow
      label={
        <Group gap={10} wrap="nowrap">
          <ItemIcon icon={icon} color={color} off={client.state !== "online"} />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" fw={500} truncate>
              {client.name ?? client.mac}
            </Text>
            <Text size="xs" c="dimmed" truncate>
              {[client.ipv4, client.network, how(client)].filter(Boolean).join(" · ")}
            </Text>
          </Stack>
        </Group>
      }
    >
      <Group gap="sm" wrap="nowrap">
        {client.traffic && (
          <Text size="xs" c="dimmed" ta="right" style={{ whiteSpace: "nowrap" }}>
            ↓ {bytes(client.traffic.down)} · ↑ {bytes(client.traffic.up)}
          </Text>
        )}
        {wifi?.band && <Chip color={bandColor(wifi.band)}>{wifi.band}</Chip>}
        {wifi && <SignalBars dbm={wifi.signal} />}
        {client.connection.kind === "wired" && <Chip color="gray">Cable</Chip>}
        {client.reserved ? (
          <Chip color="gray">Fixed address</Chip>
        ) : (
          client.ipv4 &&
          network >= 0 && (
            <Button size="compact-xs" variant="subtle" color="gray" onClick={reserve}>
              Reserve
            </Button>
          )
        )}
        {client.state !== "online" && <Chip color="gray">{client.state === "recent" ? "Seen lately" : "Away"}</Chip>}
      </Group>
    </SettingRow>
  );
};

const sorts: Record<string, (a: ClientView, b: ClientView) => number> = {
  name: () => 0,
  traffic: (a, b) => (b.traffic ? b.traffic.down + b.traffic.up : -1) - (a.traffic ? a.traffic.down + a.traffic.up : -1),
  signal: (a, b) =>
    (b.connection.kind === "wifi" ? (b.connection.signal ?? -200) : -300) - (a.connection.kind === "wifi" ? (a.connection.signal ?? -200) : -300),
};

export const ClientsPage = () => {
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus("clients");
  const history = useSeries("clients");
  const [search, setSearch] = useState("");
  const [network, setNetwork] = useState<string | null>(null);
  const [which, setWhich] = useState("online");
  const [sort, setSort] = useState("name");
  const all = status.data?.clientList ?? [];
  const online = all.filter((c) => c.state === "online");
  const wifi = online.filter((c) => c.connection.kind === "wifi");
  const bands = ["2.4 GHz", "5 GHz", "6 GHz"]
    .map((b) => [b, wifi.filter((c) => c.connection.kind === "wifi" && c.connection.band === b).length] as const)
    .filter(([, n]) => n);
  const top = [...all].sort(sorts.traffic)[0];
  const term = search.trim().toLowerCase();
  const shown = all
    .filter(
      (c) =>
        (which === "all" || c.state === "online") &&
        (!network || c.network === network) &&
        (!term || [c.name, c.mac, c.ipv4, ...c.ipv6, c.connection.kind === "wifi" ? c.connection.accessPoint : ""].some((v) => v?.toLowerCase().includes(term)))
    )
    .sort(sorts[sort]);
  return (
    <SettingsPage title="Clients" description={liveLine(intent.site.name, status.dataUpdatedAt, status.isFetching, !!status.data)}>
      <SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
        <Tile label="Online" value={status.data ? online.length : "—"} color="cyan" sub={status.data ? `${all.length} known` : undefined}>
          <AreaChart series={[history]} colors={["cyan"]} height={28} />
        </Tile>
        <Tile label="On Wi-Fi" value={status.data ? wifi.length : "—"} sub={status.data ? bands.map(([b, n]) => `${n} on ${b}`).join(" · ") || "None now" : undefined} />
        <Tile label="By cable" value={status.data ? online.filter((c) => c.connection.kind === "wired").length : "—"} sub={status.data ? "Or not on Wi-Fi" : undefined} />
        <Tile
          label="Most traffic"
          value={<Text fz={18} fw={600} truncate>{top?.traffic ? (top.name ?? top.mac) : "—"}</Text>}
          sub={top?.traffic ? `↓ ${bytes(top.traffic.down)} · ↑ ${bytes(top.traffic.up)}` : "Counted by the router"}
        />
      </SimpleGrid>
      <Group gap="sm">
        <TextInput placeholder="Name, address or MAC" leftSection={<IconSearch size={14} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} w={220} />
        <Select placeholder="Every network" clearable data={intent.networks.map((n) => n.name)} value={network} onChange={setNetwork} w={160} />
        <SegmentedControl size="xs" value={which} onChange={setWhich} data={[{ value: "online", label: "Online" }, { value: "all", label: "All" }]} />
        <Select
          size="xs"
          w={130}
          value={sort}
          onChange={(v) => setSort(v ?? "name")}
          allowDeselect={false}
          data={[
            { value: "name", label: "By name" },
            { value: "traffic", label: "By traffic" },
            { value: "signal", label: "By signal" },
          ]}
        />
      </Group>
      <Section>
        {shown.length === 0 ? (
          <EmptyState icon={IconDevices}>{status.data ? "No devices match." : "Reading the network…"}</EmptyState>
        ) : (
          shown.map((c) => <ClientRow key={c.mac} client={c} />)
        )}
      </Section>
    </SettingsPage>
  );
};
