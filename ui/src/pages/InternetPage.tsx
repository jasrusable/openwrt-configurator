// Internet: the router's connections, as a list (a line on a port each, with
// its own smart queueing), and how several are used together. The first is
// the main one: the networks' IPv6 comes from it, and in failover it carries
// everything while it works.
import { Button, Text } from "@mantine/core";
import { IconWorld } from "@tabler/icons-react";
import { useLocation, useNavigate } from "react-router";
import { portTakenBy } from "../../../src/intent/connections";
import { Intent, netmask } from "../../../src/intent/schema";
import { useDevices } from "../data/devices";
import { modelOf, portsOf, routerFacts } from "../facts";
import { useDraft, useDraftValue } from "../form/draft";
import {
  NumberField,
  OptionalField,
  PasswordField,
  SegmentedField,
  SelectField,
  SwitchField,
  TagsField,
  TextField,
  Value,
  VariantField,
  When,
} from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";
import { ItemIcon, ItemName, Section, SettingRow } from "../kit/layout";

const address = /[\d.]/;

const masks = Array.from({ length: 23 }, (_, i) => 30 - i).map((length) => ({
  value: length,
  label: `${netmask(length)} (/${length})`,
}));

const prefixes = [
  { value: "auto", label: "Automatic" },
  { value: "48", label: "/48 · 65,536 networks" },
  { value: "56", label: "/56 · 256 networks" },
  { value: "60", label: "/60 · 16 networks" },
  { value: "64", label: "/64 · 1 network" },
] as const;

const lines = [
  { value: "fibre", label: "Fibre or Ethernet" },
  { value: "cable", label: "Cable" },
  { value: "vdsl", label: "VDSL" },
  { value: "adsl", label: "ADSL" },
] as const;

const types: Record<string, string> = { dhcp: "DHCP", pppoe: "PPPoE", static: "Static IP" };

type Connection = Intent["internet"]["connections"][number];

/** The router's ports, from its facts: the WAN one, and the rest. */
const useRouterPorts = () => {
  const intent: Intent = useDraftValue();
  const router = routerFacts(intent, useDevices().data?.facts);
  return router && { name: router.name, model: modelOf(router.schema), ...portsOf(router.schema) };
};

/** "WAN port (eth1)", or the port's own name. */
const usePortLabel = () => {
  const ports = useRouterPorts();
  return (port: string | undefined) => (port ?? (ports?.wan[0] ? `WAN port (${ports.wan[0]})` : "WAN port"));
};

/** Its place: the main one, a backup in order, or its share of traffic. */
const useRole = (index: number) => {
  const intent: Intent = useDraftValue();
  const { connections, mode } = intent.internet;
  if (connections.length < 2) return "Main";
  if (mode === "balance") return `Share ${connections[index]?.weight ?? 1}`;
  return index === 0 ? "Main" : connections.length > 2 ? `Backup ${index}` : "Backup";
};

const RoleText = ({ index }: { index: number }) => (
  <Text size="sm" c="dimmed">
    {useRole(index)}
  </Text>
);

const PortText = ({ index }: { index: number }) => {
  const label = usePortLabel();
  const port: string | undefined = useDraftValue(`internet.connections.${index}.port`);
  return (
    <Text size="sm" c="dimmed" ff="monospace">
      {label(port)}
    </Text>
  );
};

/**
 * Which port the line plugs into: the router's WAN port (unset), or another
 * of its ports, from its facts; one another connection uses is greyed out.
 * Without facts yet, a port's name typed in.
 */
const PortField = ({ index }: { index: number }) => {
  const intent: Intent = useDraftValue();
  const ports = useRouterPorts();
  const label = usePortLabel();
  const name = `internet.connections.${index}.port` as const;
  const current = intent.internet.connections[index]?.port;
  if (!ports) {
    return <TextField name={name} label="Port" placeholder="eth2" description="Unset: the router's WAN port." />;
  }
  const names = [...new Set([...ports.lan, ...ports.wan.slice(1), ...(current ? [current] : [])])];
  return (
    <SelectField
      name={name}
      label="Port"
      description={`On ${ports.name} · ${ports.model}`}
      emptyLabel={label(undefined)}
      options={names.map((port) => {
        const other = portTakenBy(intent, index, port);
        const last = current !== port && lastLanPort(ports.lan, intent, index) === port;
        return {
          value: port,
          label: `${port}${ports.lan.includes(port) ? " · leaves the home network" : ""}`,
          disabled: !!other || last,
          reason: other
            ? `${other.name || "Another connection"} uses it.`
            : last
              ? "The home network's last port: the router would be unreachable."
              : undefined,
        };
      })}
    />
  );
};

/**
 * The home network's one remaining port, when only one is left free of the
 * other connections: giving it away would leave the router reachable by
 * nothing but Wi-Fi it does not have.
 */
const lastLanPort = (lan: string[], intent: Intent, index: number) => {
  const free = lan.filter((p) => !portTakenBy(intent, index, p));
  return free.length === 1 ? free[0] : undefined;
};

/** The main connection, or a backup that can become it (failover tries them in this order). */
const PriorityRow = ({ index }: { index: number }) => {
  const navigate = useNavigate();
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const role = useRole(index);
  // Not on a connection being added: it is not in the list yet.
  const adding = useLocation().pathname.endsWith("/new");
  const { connections } = intent.internet;
  if (connections.length < 2) return null;
  const makeMain = () => {
    const moved = [connections[index], ...connections.filter((_, i) => i !== index)];
    draft.replace({ ...intent, internet: { ...intent.internet, connections: moved } });
    navigate("/internet/0");
  };
  return index === 0 ? (
    <SettingRow label="Main connection" description="Used first; your networks get IPv6 from it." />
  ) : (
    <SettingRow label={role} description="Used when the ones above it fail.">
      {!adding && (
        <Button variant="default" size="xs" onClick={makeMain}>
          Make main
        </Button>
      )}
    </SettingRow>
  );
};

const newConnection = (items: Connection[]): Connection => ({
  id: [..."bcdefghijklmnopqrstuvwxyz"].map((l) => `wan${l}`).find((id) => !items.some((c) => c.id === id))!,
  name: "",
  connection: { type: "dhcp" },
  // The networks' IPv6 comes from the main connection.
  ipv6: false,
  ipv6_prefix: "auto",
  weight: 1,
  metered: false,
  down_when_slow: false,
});

const connections = defineList({
  name: "internet.connections",
  title: "Connections",
  addLabel: "Add connection",
  newItem: newConnection,
  // On a free port: the WAN port if no connection has it, else the first
  // port of the router's no other connection uses.
  useNewItem: () => {
    const ports = useRouterPorts();
    return (items, intent) => {
      const item = newConnection(items);
      if (!items.some((c) => c.port === undefined)) return item;
      const last = lastLanPort(ports?.lan ?? [], intent, -1);
      const free = [...(ports?.wan.slice(1) ?? []), ...(ports?.lan ?? [])].find(
        (p) => !portTakenBy(intent, -1, p) && p !== last
      );
      return free ? { ...item, port: free } : item;
    };
  },
  canRemove: (_, items) => items.length > 1,
  // Networks keeping to it go back to Automatic.
  onRemove: (intent, index) => {
    const gone = intent.internet.connections[index];
    return {
      ...intent,
      internet: { ...intent.internet, connections: intent.internet.connections.filter((_, i) => i !== index) },
      networks: intent.networks.map(({ line, ...network }) =>
        line?.connection === gone?.id ? network : { ...network, ...(line ? { line } : {}) }
      ),
    };
  },
  itemTitle: (i) => <Value name={`internet.connections.${i}.name`} fallback="New connection" />,
  empty: "No connections.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <ItemName icon={<ItemIcon icon={IconWorld} color="indigo" />}>
          <Value name={`internet.connections.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    { header: "Port", cell: (i) => <PortText index={i} /> },
    {
      header: "Type",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value name={`internet.connections.${i}.connection.type`} format={(t) => types[t as string] ?? t} />
        </Text>
      ),
    },
    { header: "Role", cell: (i) => <RoleText index={i} /> },
  ],
  editor: (i) => {
    const at = `internet.connections.${i}` as const;
    return (
      <>
        <Section>
          <TextField name={`${at}.name`} label="Name" placeholder="Fibre" />
          <PortField index={i} />
          <PriorityRow index={i} />
        </Section>
        <Section title="Connection">
          <VariantField
            name={`${at}.connection`}
            label="Type"
            variants={[
              { value: "dhcp", label: "DHCP", initial: { type: "dhcp" } },
              { value: "pppoe", label: "PPPoE", initial: { type: "pppoe", username: "", password: "" } },
              {
                value: "static",
                label: "Static IP",
                initial: { type: "static", address: "", prefix_length: 24, gateway: "" },
              },
            ]}
          />
          <When name={`${at}.connection.type`} is="pppoe">
            <TextField name={`${at}.connection.username`} label="Username" />
            <PasswordField name={`${at}.connection.password`} label="Password" />
          </When>
          <When name={`${at}.connection.type`} is="static">
            <TextField name={`${at}.connection.address`} label="IP address" placeholder="203.0.113.10" chars={address} />
            <SelectField name={`${at}.connection.prefix_length`} label="Subnet mask" options={masks} />
            <TextField name={`${at}.connection.gateway`} label="Gateway" placeholder="203.0.113.1" chars={address} />
            <TagsField
              name={`${at}.connection.dns`}
              label="DNS servers"
              description="From your provider. Not needed with encrypted DNS."
              placeholder="Add a server"
            />
          </When>
          <OptionalField
            name={`${at}.vlan`}
            label="VLAN tag"
            description="Only if your provider says the line needs one."
            initial={10}
          >
            <NumberField name={`${at}.vlan`} label="VLAN ID" min={1} max={4094} integer />
          </OptionalField>
        </Section>
        <Section>
          <SwitchField name={`${at}.ipv6`} label="IPv6" />
          <When name={`${at}.ipv6`} is={true}>
            <SelectField
              name={`${at}.ipv6_prefix`}
              label="Prefix size"
              description="Each network with IPv6 needs a /64."
              options={[...prefixes]}
            />
          </When>
        </Section>
        <Section description="Keeps calls smooth under load. Set just below this line's speed.">
          <OptionalField name={`${at}.speed`} label="Smart queueing" initial={{ down_mbps: 100, up_mbps: 20, line: "fibre" }}>
            <NumberField name={`${at}.speed.down_mbps`} label="Download" unit="Mbit/s" min={1} />
            <NumberField name={`${at}.speed.up_mbps`} label="Upload" unit="Mbit/s" min={1} />
            <SelectField
              name={`${at}.speed.line`}
              label="Line type"
              description="Sets the per-packet overhead."
              options={[...lines]}
            />
          </OptionalField>
        </Section>
        <ShareSection index={i} />
      </>
    );
  },
});

/** How it works with the others: shown once there are several. */
const ShareSection = ({ index }: { index: number }) => {
  const intent: Intent = useDraftValue();
  const at = `internet.connections.${index}` as const;
  if (intent.internet.connections.length < 2) return null;
  return (
    <Section title="With your other connections">
      {intent.internet.mode === "balance" && (
        <NumberField name={`${at}.weight`} label="Share" min={1} max={100} integer />
      )}
      <SwitchField name={`${at}.metered`} label="Metered" />
      <SwitchField name={`${at}.down_when_slow`} label="Down when slow" />
    </Section>
  );
};

/** What applies to the internet as a whole: how several lines work together, and UPnP. */
const Together = () => {
  const intent: Intent = useDraftValue();
  return (
    <>
      {intent.internet.connections.length > 1 && (
        <Section>
          <SegmentedField
            name="internet.mode"
            label="Using several"
            options={[
              { value: "failover", label: "Failover" },
              { value: "balance", label: "Share traffic" },
            ]}
          />
          {intent.internet.mode === "balance" && (
            <SwitchField name="internet.share_per_device" label="Keep each device on one line" />
          )}
        </Section>
      )}
      <Section description="Main network only; devices open ports for themselves.">
        <SwitchField name="internet.upnp" label="UPnP and NAT-PMP" description="Lets games and apps open the ports they need." />
      </Section>
    </>
  );
};

export const InternetPage = () => (
  <ListPage
    list={connections}
    page={{ title: "Internet", description: "How your router connects: one line, or several.", after: <Together /> }}
  />
);
