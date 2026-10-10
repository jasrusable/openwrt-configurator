import { Group, Text } from "@mantine/core";
import { protocols } from "../../../../src/intent/firewall";
import { PolicyBadge, policyOptions, ZoneName, ZoneSelectField } from "../../firewall/zones";
import {
  SegmentedField,
  SelectField,
  SwitchField,
  TagsField,
  TextField,
  Value,
  When,
} from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { Section } from "../../kit/layout";

const protocolLabels: Record<(typeof protocols)[number], string> = {
  "tcp+udp": "TCP and UDP",
  tcp: "TCP",
  udp: "UDP",
  icmp: "ICMP",
  any: "Any",
};

const rules = defineList({
  name: "firewall.rules",
  title: "Rules",
  description:
    "Traffic rules decide what the zone policies and forwardings do not: specific ports, addresses or traffic to the router.",
  addLabel: "Add rule",
  newItem: (_, intent) => ({
    name: "",
    enabled: true,
    from: intent.firewall.zones[0]?.id ?? "wan",
    to: "router",
    protocol: "tcp+udp" as const,
    family: "any" as const,
    action: "accept" as const,
  }),
  itemTitle: (i) => <Value name={`firewall.rules.${i}.name`} fallback="New rule" />,
  empty: "No rules of your own. The built-in ones are in Firewall › Settings.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <Text size="sm" fw={500}>
          <Value name={`firewall.rules.${i}.name`} fallback="Unnamed" />
        </Text>
      ),
    },
    {
      header: "From → To",
      cell: (i) => (
        <Text size="sm">
          <Value name={`firewall.rules.${i}.from`} format={(id) => <ZoneName id={id} />} />
          {" → "}
          <Value name={`firewall.rules.${i}.to`} format={(id) => <ZoneName id={id} />} />
        </Text>
      ),
    },
    {
      header: "Traffic",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value
            name={`firewall.rules.${i}`}
            format={(rule) =>
              rule &&
              `${protocolLabels[rule.protocol as keyof typeof protocolLabels] ?? rule.protocol}${
                rule.ports ? ` ${rule.ports}` : ""
              }`
            }
          />
        </Text>
      ),
    },
    {
      header: "Action",
      cell: (i) => (
        <Group gap={6}>
          <Value name={`firewall.rules.${i}.action`} format={(a) => <PolicyBadge policy={a} />} />
          <Value
            name={`firewall.rules.${i}.enabled`}
            format={(on) => !on && <Text size="xs" c="dimmed">Off</Text>}
          />
        </Group>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`firewall.rules.${i}.name`} label="Name" />
        <SwitchField name={`firewall.rules.${i}.enabled`} label="Enabled" />
        <SegmentedField name={`firewall.rules.${i}.action`} label="Action" options={policyOptions} />
      </Section>
      <Section title="Traffic">
        <ZoneSelectField name={`firewall.rules.${i}.from`} label="From" wan />
        <ZoneSelectField
          name={`firewall.rules.${i}.to`}
          label="To"
          description="A zone, or the router itself."
          wan
          router
        />
        <SelectField
          name={`firewall.rules.${i}.protocol`}
          label="Protocol"
          options={protocols.map((p) => ({ value: p, label: protocolLabels[p] }))}
        />
        <When name={`firewall.rules.${i}.protocol`} is="tcp+udp">
          <PortsField index={i} />
        </When>
        <When name={`firewall.rules.${i}.protocol`} is="tcp">
          <PortsField index={i} />
        </When>
        <When name={`firewall.rules.${i}.protocol`} is="udp">
          <PortsField index={i} />
        </When>
        <SegmentedField
          name={`firewall.rules.${i}.family`}
          label="IP version"
          options={[
            { value: "any", label: "Both" },
            { value: "ipv4", label: "IPv4" },
            { value: "ipv6", label: "IPv6" },
          ]}
        />
      </Section>
      <Section title="Addresses" description="Leave empty to match any address.">
        <TagsField
          name={`firewall.rules.${i}.source_addresses`}
          label="Source"
          placeholder="10.0.0.5 or 10.0.0.0/24"
        />
        <TagsField
          name={`firewall.rules.${i}.destination_addresses`}
          label="Destination"
          placeholder="10.0.0.20"
        />
      </Section>
    </>
  ),
});

const PortsField = ({ index }: { index: number }) => (
  <TextField
    name={`firewall.rules.${index}.ports`}
    label="Destination ports"
    description="Like 443, 8000-8100 or 80,443. Empty: every port."
    placeholder="Any"
  />
);

export const RulesPage = ({ sub }: { sub: string }) => <ListPage list={rules} sub={sub} />;
