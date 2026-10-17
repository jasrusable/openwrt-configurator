// Your own rules: exceptions to what each network's access allows, in order.
import { IconBan, IconCircleCheck } from "@tabler/icons-react";
import { ItemIcon, ItemName } from "../../kit/layout";
import { useDraftValue } from "../../form/draft";
import { Text } from "@mantine/core";
import {
  actionOptions,
  EndSelectField,
  useRuleSummary,
} from "../../firewall/ends";
import {
  SegmentedField,
  SelectField,
  SwitchField,
  TagsField,
  TextField,
  Value,
} from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { Section } from "../../kit/layout";
import { protocolOptions } from "../../../../src/intent/labels";

const RuleMatch = ({ index }: { index: number }) => {
  const summary = useRuleSummary(useDraftValue(`firewall.rules.${index}`));
  return (
    <Text size="sm" c="dimmed">
      {summary}
    </Text>
  );
};


/** Allow or block, grey while the rule is off. */
const RuleIcon = ({ index }: { index: number }) => {
  const allow = useDraftValue(`firewall.rules.${index}.action`) === "allow";
  const on = useDraftValue(`firewall.rules.${index}.enabled`) !== false;
  return <ItemIcon icon={allow ? IconCircleCheck : IconBan} color={allow ? "green" : "red"} off={!on} />;
};

const rules = defineList({
  name: "firewall.rules",
  title: "Rules",
  description:
    `Exceptions to each network's access, in order.`,
  addLabel: "Add rule",
  // Matched in order: the first rule a connection meets decides.
  reorderable: true,
  newItem: (_, intent) => ({
    name: "",
    enabled: true,
    // From another network to the main one; with only the main one, from it to the router.
    from: intent.networks.find((n) => n.vlan !== undefined)?.id ?? intent.networks[0].id,
    to: intent.networks.some((n) => n.vlan !== undefined)
      ? (intent.networks.find((n) => n.vlan === undefined)?.id ?? "router")
      : "router",
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
        <ItemName icon={<RuleIcon index={i} />}>
          <Value name={`firewall.rules.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    { header: "Traffic", cell: (i) => <RuleMatch index={i} /> },
    {
      header: "Action",
      width: 110,
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value name={`firewall.rules.${i}.action`} format={(a) => (a === "allow" ? "Allow" : "Block")} />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`firewall.rules.${i}.name`} />
        <SegmentedField name={`firewall.rules.${i}.action`} options={actionOptions} />
        <SwitchField name={`firewall.rules.${i}.enabled`} />
      </Section>
      <Section title="Traffic">
        <EndSelectField name={`firewall.rules.${i}.from`} label="From" />
        <TagsField
          name={`firewall.rules.${i}.from_addresses`}
          placeholder="Any"
        />
        <EndSelectField name={`firewall.rules.${i}.to`} label="To" destination />
        <TagsField
          name={`firewall.rules.${i}.to_addresses`}
          placeholder="Any"
        />
        <SelectField
          name={`firewall.rules.${i}.protocol`}
          options={protocolOptions}
        />
        <TextField
          name={`firewall.rules.${i}.ports`}
          placeholder="Any"
          chars={/[\d ,-]/}
        />
      </Section>
    </>
  ),
});

export const RulesPage = ({ sub }: { sub: string }) => <ListPage list={rules} sub={sub} />;
