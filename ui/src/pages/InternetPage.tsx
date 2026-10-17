// Internet: the router's connections, as a list (a line on a port each, with
// its own smart queueing), and how several are used together. The first is
// the main one: the networks' IPv6 comes from it, and in failover it carries
// everything while it works.
import { Button, Text } from "@mantine/core";
import { IconWorld } from "@tabler/icons-react";
import { useLocation, useNavigate } from "react-router";
import { lineRole, portTakenBy, withMain } from "../../../src/intent/connections";
import { withoutLine } from "../../../src/intent/edits";
import { Intent } from "../../../src/intent/schema";
import { netmask } from "../../../src/intent/addresses";
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
import { Experimental, ItemIcon, ItemName, Section, SettingRow } from "../kit/layout";
import { lineTypeLabels } from "../../../src/intent/labels";

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


type Connection = Intent["internet"]["lines"][number];

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
const useRole = (index: number) => lineRole(useDraftValue(), index);

const RoleText = ({ index }: { index: number }) => (
  <Text size="sm" c="dimmed">
    {useRole(index).label}
  </Text>
);

const PortText = ({ index }: { index: number }) => {
  const label = usePortLabel();
  const port: string | undefined = useDraftValue(`internet.lines.${index}.port`);
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
  const name = `internet.lines.${index}.port` as const;
  const current = intent.internet.lines[index]?.port;
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

/** Whether another line is on `port`, whatever its VLAN: it takes the port from the home network. */
const onPort = (intent: Intent, index: number, port: string) => intent.internet.lines.some((c, i) => i !== index && c.port === port);

/**
 * The home network's one remaining port, when only one is left free of the
 * other connections: giving it away would leave the router reachable by
 * nothing but Wi-Fi it does not have.
 */
const lastLanPort = (lan: string[], intent: Intent, index: number) => {
  // The WAN port joins the home network when no other connection is on it.
  const wanFree = !intent.internet.lines.some((c, i) => i !== index && c.port === undefined);
  const free = lan.filter((p) => !onPort(intent, index, p));
  return free.length === 1 && !wanFree ? free[0] : undefined;
};

/** The main connection, or a backup that can become it (failover tries them in this order). */
const PriorityRow = ({ index }: { index: number }) => {
  const navigate = useNavigate();
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const role = useRole(index);
  // Not on a connection being added: it is not in the list yet.
  const adding = useLocation().pathname.endsWith("/new");
  const connections = intent.internet.lines;
  if (connections.length < 2) return null;
  const makeMain = () => {
    draft.replace({ ...intent, internet: { ...intent.internet, lines: withMain(connections, index) } });
    navigate("/internet/0");
  };
  return (
    <SettingRow label={role.label} description={role.description}>
      {index > 0 && !adding && (
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
  type: "dhcp",
  // The networks' IPv6 comes from the main line.
  ipv6: { enabled: false, prefix: "auto" },
  failover: { weight: 1, metered: false, down_when_slow: false },
});

const connections = defineList({
  name: "internet.lines",
  title: "Connections",
  addLabel: "Add connection",
  // On a free port: the WAN port if no connection has it, else the first
  // port of the router's no other connection uses.
  useNewItem: () => {
    const ports = useRouterPorts();
    return (items, intent) => {
      const item = newConnection(items);
      if (!items.some((c) => c.port === undefined)) return item;
      const last = lastLanPort(ports?.lan ?? [], intent, -1);
      const free = [...(ports?.wan.slice(1) ?? []), ...(ports?.lan ?? [])].find(
        (p) => !onPort(intent, -1, p) && p !== last
      );
      return free ? { ...item, port: free } : item;
    };
  },
  canRemove: (_, items) => items.length > 1,
  // Networks keeping to it go back to Automatic.
  onRemove: withoutLine,
  itemTitle: (i) => <Value name={`internet.lines.${i}.name`} fallback="New connection" />,
  empty: "No connections.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <ItemName icon={<ItemIcon icon={IconWorld} color="indigo" />}>
          <Value name={`internet.lines.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    { header: "Port", cell: (i) => <PortText index={i} /> },
    {
      header: "Type",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value name={`internet.lines.${i}.type`} format={(t) => t && lineTypeLabels[t]} />
        </Text>
      ),
    },
    { header: "Role", cell: (i) => <RoleText index={i} /> },
  ],
  editor: (i) => {
    const at = `internet.lines.${i}` as const;
    return (
      <>
        <Section>
          <TextField name={`${at}.name`} label="Name" placeholder="Fibre" />
          <PortField index={i} />
          <PriorityRow index={i} />
        </Section>
        <Section title="Connection">
          <VariantField
            name={at}
            label="Type"
            within
            variants={[
              { value: "dhcp", label: lineTypeLabels.dhcp, initial: { type: "dhcp" } },
              { value: "pppoe", label: lineTypeLabels.pppoe, initial: { type: "pppoe", pppoe: { username: "", password: "" } } },
              {
                value: "static",
                label: lineTypeLabels.static,
                initial: { type: "static", static: { address: "", prefix_length: 24, gateway: "" } },
              },
            ]}
          />
          <When name={`${at}.type`} is="pppoe">
            <TextField name={`${at}.pppoe.username`} label="Username" />
            <PasswordField name={`${at}.pppoe.password`} label="Password" />
          </When>
          <When name={`${at}.type`} is="static">
            <TextField name={`${at}.static.address`} label="IP address" placeholder="203.0.113.10" chars={address} />
            <SelectField name={`${at}.static.prefix_length`} label="Subnet mask" options={masks} />
            <TextField name={`${at}.static.gateway`} label="Gateway" placeholder="203.0.113.1" chars={address} />
            <TagsField
              name={`${at}.static.dns`}
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
          <SwitchField name={`${at}.ipv6.enabled`} label="IPv6" />
          <When name={`${at}.ipv6.enabled`} is={true}>
            <SelectField
              name={`${at}.ipv6.prefix`}
              label="Prefix size"
              description="Each network with IPv6 needs a /64."
              options={[...prefixes]}
            />
          </When>
        </Section>
        <Section description="Keeps calls smooth under load. Set just below this line's speed.">
          <OptionalField name={`${at}.shaping`} label="Smart queueing" initial={{ down_mbps: 100, up_mbps: 20, medium: "fibre" }}>
            <NumberField name={`${at}.shaping.down_mbps`} label="Download" unit="Mbit/s" min={1} />
            <NumberField name={`${at}.shaping.up_mbps`} label="Upload" unit="Mbit/s" min={1} />
            <SelectField
              name={`${at}.shaping.medium`}
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
  const at = `internet.lines.${index}` as const;
  if (intent.internet.lines.length < 2) return null;
  return (
    <Section title="With your other connections">
      {intent.internet.use_lines.mode === "balance" && (
        <NumberField name={`${at}.failover.weight`} label="Share" min={1} max={100} integer />
      )}
      <SwitchField name={`${at}.failover.metered`} label="Metered" />
      <SwitchField name={`${at}.failover.down_when_slow`} label="Down when slow" />
    </Section>
  );
};

/** What applies to the internet as a whole: how several lines work together, and UPnP. */
const Together = () => {
  const intent: Intent = useDraftValue();
  return (
    <>
      {intent.internet.lines.length > 1 && (
        <Section>
          <SegmentedField
            name="internet.use_lines.mode"
            options={[
              { value: "failover", label: "Failover" },
              { value: "balance", label: "Share traffic" },
            ]}
          />
          {intent.internet.use_lines.mode === "balance" && (
            <SwitchField name="internet.use_lines.sticky_per_device" />
          )}
        </Section>
      )}
      <Section
        title={<Experimental>Name on the internet</Experimental>}
      >
        <OptionalField
          name="internet.dynamic_dns"
          initial={{ provider: "duckdns", hostname: "", token: "" }}
        >
          <SelectField
            name="internet.dynamic_dns.provider"
            options={[
              { value: "duckdns", label: "Duck DNS" },
              { value: "cloudflare", label: "Cloudflare" },
              { value: "dynv6", label: "dynv6" },
            ]}
          />
          <TextField name="internet.dynamic_dns.hostname" placeholder="myhome.duckdns.org" />
          <PasswordField name="internet.dynamic_dns.token" />
          {/* Cloudflare's; still shown while set for another, so what it holds can be seen and cleared. */}
          {(intent.internet.dynamic_dns?.provider === "cloudflare" || intent.internet.dynamic_dns?.zone !== undefined) && (
            <TextField name="internet.dynamic_dns.zone" placeholder="example.com" />
          )}
        </OptionalField>
      </Section>
      <Section description="Main network only; devices open ports for themselves.">
        <SwitchField name="internet.upnp" />
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
