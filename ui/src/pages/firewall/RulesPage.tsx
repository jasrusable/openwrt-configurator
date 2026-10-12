// Your own rules: exceptions to what each network's access allows, in order.
import { useDraftValue } from "../../form/draft";
import { Text } from "@mantine/core";
import {
  ActionBadge,
  actionOptions,
  EndSelectField,
  protocolOptions,
  useRuleSummary,
} from "../../firewall/ends";
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

const RuleMatch = ({ index }: { index: number }) => {
  const summary = useRuleSummary(useDraftValue(`firewall.rules.${index}`));
  return (
    <Text size="sm" c="dimmed">
      {summary}
    </Text>
  );
};


const rules = defineList({
  name: "firewall.rules",
  title: "Rules",
  description:
    "Exceptions to what each network may reach (Networks › Access), applied in order.",
  addLabel: "Add rule",
  newItem: (_, intent) => ({
    name: "",
    enabled: true,
    from: intent.networks.find((n) => n.vlan !== undefined)?.id ?? intent.networks[0].id,
    to: intent.networks.find((n) => n.vlan === undefined)?.id ?? "router",
    protocol: "tcp+udp" as const,
    action: "allow" as const,
  }),
  itemTitle: (i) => <Value name={`firewall.rules.${i}.name`} fallback="New rule" />,
  empty: "No rules: each network's access decides.",
  columns: [
    {
      header: "Name",
      width: 210,
      cell: (i) => (
        <Text size="sm" fw={500}>
          <Value name={`firewall.rules.${i}.name`} fallback="Unnamed" />
        </Text>
      ),
    },
    { header: "Traffic", cell: (i) => <RuleMatch index={i} /> },
    {
      header: "Action",
      width: 110,
      cell: (i) => (
        <Value name={`firewall.rules.${i}.action`} format={(a) => <ActionBadge action={a} />} />
      ),
    },
    {
      header: "Enabled",
      width: 90,
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value name={`firewall.rules.${i}.enabled`} format={(on) => (on ? "Yes" : "No")} />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`firewall.rules.${i}.name`} label="Name" />
        <SegmentedField name={`firewall.rules.${i}.action`} label="Action" options={actionOptions} />
        <SwitchField name={`firewall.rules.${i}.enabled`} label="Enabled" />
      </Section>
      <Section title="Traffic">
        <EndSelectField name={`firewall.rules.${i}.from`} label="From" />
        <TagsField
          name={`firewall.rules.${i}.source_addresses`}
          label="From devices"
          description="Addresses or ranges, like 10.0.0.20 or 10.0.0.0/28."
          placeholder="Any"
        />
        <EndSelectField name={`firewall.rules.${i}.to`} label="To" destination />
        <TagsField
          name={`firewall.rules.${i}.destination_addresses`}
          label="To devices"
          placeholder="Any"
        />
        <SelectField
          name={`firewall.rules.${i}.protocol`}
          label="Protocol"
          options={protocolOptions}
        />
        <TextField
          name={`firewall.rules.${i}.destination_port`}
          label="Ports"
          description="Like 443, 8000-8100 or 80 443."
          placeholder="Any"
          chars={/[\d ,-]/}
        />
      </Section>
    </>
  ),
});

export const RulesPage = ({ sub }: { sub: string }) => <ListPage list={rules} sub={sub} />;
