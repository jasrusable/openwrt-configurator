import { Group, Text } from "@mantine/core";
import {
  SegmentedField,
  SwitchField,
  TagsField,
  TextField,
  Value,
} from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { Section } from "../../kit/layout";

const protocolOptions = [
  { value: "tcp+udp" as const, label: "TCP and UDP" },
  { value: "tcp" as const, label: "TCP" },
  { value: "udp" as const, label: "UDP" },
];

const forwards = defineList({
  name: "firewall.port_forwards",
  title: "Port forwarding",
  description: "Let traffic from the internet reach a device inside (DNAT).",
  addLabel: "Add port forward",
  newItem: () => ({
    name: "",
    enabled: true,
    protocol: "tcp" as const,
    external_port: "",
    internal_address: "",
    reflection: true,
  }),
  itemTitle: (i) => <Value name={`firewall.port_forwards.${i}.name`} fallback="New port forward" />,
  empty: "Nothing is forwarded.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <Text size="sm" fw={500}>
          <Value name={`firewall.port_forwards.${i}.name`} fallback="Unnamed" />
        </Text>
      ),
    },
    {
      header: "External",
      cell: (i) => (
        <Text size="sm" ff="monospace">
          <Value
            name={`firewall.port_forwards.${i}`}
            format={(f) => f && `${f.protocol.toUpperCase()} ${f.external_port}`}
          />
        </Text>
      ),
    },
    {
      header: "To",
      cell: (i) => (
        <Text size="sm" ff="monospace">
          <Value
            name={`firewall.port_forwards.${i}`}
            format={(f) => f && `${f.internal_address}:${f.internal_port || f.external_port}`}
          />
        </Text>
      ),
    },
    {
      header: "",
      cell: (i) => (
        <Group>
          <Value
            name={`firewall.port_forwards.${i}.enabled`}
            format={(on) => !on && <Text size="xs" c="dimmed">Off</Text>}
          />
        </Group>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`firewall.port_forwards.${i}.name`} label="Name" />
        <SwitchField name={`firewall.port_forwards.${i}.enabled`} label="Enabled" />
      </Section>
      <Section title="Forward">
        <SegmentedField
          name={`firewall.port_forwards.${i}.protocol`}
          label="Protocol"
          options={protocolOptions}
        />
        <TextField
          name={`firewall.port_forwards.${i}.external_port`}
          label="External port"
          description="A port or a range, like 27015 or 6881-6889."
        />
        <TextField
          name={`firewall.port_forwards.${i}.internal_address`}
          label="To address"
          description="A device on one of your networks."
          placeholder="10.0.0.50"
        />
        <TextField
          name={`firewall.port_forwards.${i}.internal_port`}
          label="To port"
          description="Empty: the same as the external port."
          placeholder="Same"
        />
      </Section>
      <Section title="Advanced">
        <TagsField
          name={`firewall.port_forwards.${i}.source_addresses`}
          label="Only from"
          description="Empty: from anywhere."
          placeholder="203.0.113.7"
        />
        <SwitchField
          name={`firewall.port_forwards.${i}.reflection`}
          label="NAT loopback"
          description="Reachable from inside, by your public address, too."
        />
      </Section>
    </>
  ),
});

export const PortForwardsPage = ({ sub }: { sub: string }) => (
  <ListPage list={forwards} sub={sub} />
);
