// Clients: who is on the network, and is anyone badly served? Every device
// seen, online or remembered (src/status/registry.ts), as a table: how and
// where it is connected, its signal and link, its address, how much it has
// used, when it was last here. A row opens its own page (ClientPage).
import { Badge, Group, SegmentedControl, Select, Stack, Text, TextInput } from "@mantine/core";
import { IconSearch } from "@tabler/icons-react";
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import type { Intent } from "../../../../src/intent/schema";
import { clientHealth, needsLook, tone as toneOf } from "../../../../src/status/health";
import type { ClientView } from "../../../../src/status/views";
import { useNetworkStatus } from "../../data/status";
import { ago } from "../../facts";
import { useDraftValue } from "../../form/draft";
import { bytes } from "../../kit/format";
import { dbm, Panel, StatusPage, ToneValue, Verdict } from "../../kit/status";
import { StatusColumn, StatusTable } from "../../kit/StatusTable";
import { ClientPage } from "./ClientPage";
import { clientName, connectionWords, kindIcon, liveLine, ThingIcon, unread } from "./shared";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Which clients the list shows. */
const shows = {
  online: (c: ClientView) => c.state === "online",
  all: () => true,
  new: (c: ClientView) => !!c.new,
  look: (c: ClientView, poor: Set<string>) => poor.has(c.mac),
} as const;

const Tag = ({ children }: { children: React.ReactNode }) => (
  <Badge variant="default" radius="sm" size="xs" style={{ textTransform: "none", fontWeight: 500 }}>
    {children}
  </Badge>
);

const ClientList = () => {
  const navigate = useNavigate();
  const intent: Intent = useDraftValue();
  const status = useNetworkStatus();
  const live = status.data;
  const [which, setWhich] = useState<keyof typeof shows>("online");
  const [network, setNetwork] = useState<string | null>(null);
  const [accessPoint, setAccessPoint] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const all = live?.clientList ?? [];
  const radios = live?.radios ?? [];
  const online = all.filter((c) => c.state === "online");
  const health = new Map(all.map((c) => [c.mac, clientHealth(c, radios)]));
  const poor = new Set(online.filter((c) => needsLook(health.get(c.mac)!)).map((c) => c.mac));
  const fresh = all.filter((c) => c.new);
  const term = search.trim().toLowerCase();
  const rows = all.filter(
    (c) =>
      shows[which](c, poor) &&
      (!network || c.network === network) &&
      (!accessPoint || (c.connection.kind === "wifi" && c.connection.accessPoint === accessPoint)) &&
      (!term || [c.name, c.mac, c.model, c.ipv4, ...c.ipv6].some((v) => v?.toLowerCase().includes(term)))
  );
  const networkName = (id?: string) => intent.networks.find((n) => n.id === id)?.name;
  const wifi = (c: ClientView) => (c.connection.kind === "wifi" ? c.connection : undefined);
  const seen = (c: ClientView) => (c.state === "online" ? "now" : c.lastSeen ? ago(c.lastSeen) : c.state === "recent" ? "lately" : "—");
  const columns: StatusColumn<ClientView>[] = [
    {
      key: "name",
      header: "Name",
      sort: (c) => clientName(c).toLowerCase(),
      cell: (c) => (
        <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
          <ThingIcon icon={kindIcon(c.kind)} away={c.state !== "online"} />
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Group gap={6} wrap="nowrap">
              <Text size="sm" fw={500} truncate maw={220}>
                {clientName(c)}
              </Text>
              {c.new && <Tag>New</Tag>}
              {c.reserved && <Tag>Fixed address</Tag>}
            </Group>
            {c.model && (
              <Text size="xs" c="dimmed" truncate>
                {c.model}
              </Text>
            )}
          </Stack>
        </Group>
      ),
    },
    { key: "network", header: "Network", sort: (c) => networkName(c.network), cell: (c) => <Text size="sm">{networkName(c.network) ?? "—"}</Text> },
    { key: "connection", header: "Connection", sort: connectionWords, cell: (c) => <Text size="sm">{connectionWords(c)}</Text> },
    {
      key: "signal",
      header: "Signal",
      align: "right",
      sort: (c) => wifi(c)?.signal,
      cell: (c) => {
        const h = health.get(c.mac)!;
        return wifi(c)?.signal !== undefined ? (
          <ToneValue tone={c.state === "online" ? toneOf.signal(wifi(c)!.signal) : undefined} hint={h.causes.length ? h.causes.map((x) => x.text).join("; ") : undefined}>
            {dbm(wifi(c)!.signal)}
          </ToneValue>
        ) : (
          <Text size="sm" c="dimmed">
            —
          </Text>
        );
      },
    },
    {
      key: "rate",
      header: "Link ↓ / ↑",
      align: "right",
      sort: (c) => wifi(c)?.txRate,
      cell: (c) => (
        <Text size="sm" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
          {wifi(c)?.txRate !== undefined ? `${Math.round(wifi(c)!.txRate!)} / ${wifi(c)!.rxRate !== undefined ? Math.round(wifi(c)!.rxRate!) : "—"}` : "—"}
        </Text>
      ),
    },
    {
      key: "address",
      header: "Address",
      // Numerically, by each part.
      sort: (c) => (c.ipv4 ? c.ipv4.split(".").map((p) => p.padStart(3, "0")).join(".") : undefined),
      cell: (c) => (
        <Text size="sm" ff="monospace" fz={12.5}>
          {c.ipv4 ?? "—"}
        </Text>
      ),
    },
    {
      key: "traffic",
      header: "Used",
      align: "right",
      sort: (c) => (c.traffic ? c.traffic.down + c.traffic.up : undefined),
      cell: (c) => (
        <Text size="sm" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }} title={c.traffic ? `↓ ${bytes(c.traffic.down)} · ↑ ${bytes(c.traffic.up)} ${c.traffic.over === "month" ? "this month" : "since it joined"}` : undefined}>
          {c.traffic ? bytes(c.traffic.down + c.traffic.up) : "—"}
        </Text>
      ),
    },
    {
      key: "seen",
      header: "Seen",
      align: "right",
      sort: (c) => (c.state === "online" ? Number.MAX_SAFE_INTEGER : (c.lastSeen ?? 0)),
      cell: (c) => (
        <Text size="sm" c={c.state === "online" ? undefined : "dimmed"} style={{ whiteSpace: "nowrap" }}>
          {seen(c)}
        </Text>
      ),
    },
  ];
  const accessPoints = [...new Set(online.flatMap((c) => (c.connection.kind === "wifi" ? [c.connection.accessPoint] : [])))].sort();
  const onWifi = online.filter((c) => c.connection.kind === "wifi").length;
  return (
    <StatusPage title="Clients" live={liveLine(status)}>
      <Verdict
        tone={!live ? "off" : poor.size ? "fair" : "good"}
        detail={live && [`${onWifi} on Wi-Fi`, `${online.length - onWifi} by cable`, fresh.length ? `${plural(fresh.length, "new device")} today` : undefined].filter(Boolean).join(" · ")}
      >
        {!live ? "Reading the network…" : `${online.length} online${poor.size ? ` · ${poor.size} could be better served` : ""}`}
      </Verdict>
      <Group gap="sm" wrap="wrap">
        <SegmentedControl
          size="xs"
          value={which}
          onChange={(v) => setWhich(v as keyof typeof shows)}
          data={[
            { value: "online", label: `Online ${online.length}` },
            { value: "all", label: `All ${all.length}` },
            { value: "new", label: `New ${fresh.length}` },
            { value: "look", label: `Needs a look ${poor.size}` },
          ]}
        />
        <Select size="xs" placeholder="Every network" clearable data={intent.networks.map((n) => ({ value: n.id, label: n.name || "Unnamed" }))} value={network} onChange={setNetwork} w={150} />
        <Select size="xs" placeholder="Every access point" clearable data={accessPoints} value={accessPoint} onChange={setAccessPoint} w={170} />
        <TextInput size="xs" placeholder="Name, address, MAC or model" leftSection={<IconSearch size={14} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} w={230} />
      </Group>
      <Panel padded={false}>
        <StatusTable
          id="clients"
          rows={rows}
          columns={columns}
          rowKey={(c) => c.mac}
          onOpen={(c) => navigate(`/clients/${encodeURIComponent(c.mac)}`)}
          empty={live ? "No devices match." : unread(status, "Reading the network…")}
          phone={(c) => ({
            lead: (
              <Group gap={6} wrap="nowrap">
                <Text size="sm" fw={500} truncate>
                  {clientName(c)}
                </Text>
                {c.new && <Tag>New</Tag>}
              </Group>
            ),
            sub: [connectionWords(c), c.ipv4, c.state !== "online" ? seen(c) : undefined].filter(Boolean).join(" · "),
            end: wifi(c)?.signal !== undefined && c.state === "online" ? <ToneValue tone={toneOf.signal(wifi(c)!.signal)}>{dbm(wifi(c)!.signal)}</ToneValue> : undefined,
          })}
        />
      </Panel>
      {which === "all" && (
        <Text size="xs" c="dimmed" px={4}>
          Devices are remembered for 30 days after they were last online; one with a fixed address, always. A private address (one a phone makes up for each network) may come back as another.
        </Text>
      )}
    </StatusPage>
  );
};

export const ClientsPage = () => {
  const mac = useParams()["*"];
  return mac ? <ClientPage mac={decodeURIComponent(mac)} /> : <ClientList />;
};

