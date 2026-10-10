// LuCI's Traffic Rules: every rule, OpenWrt's stock ones included, in order.
import { Text } from "@mantine/core";
import { useWatch } from "react-hook-form";
import { icmpTypes } from "../../../../src/intent/firewall";
import {
  PolicyBadge,
  policyOptions,
  protocolOptions,
  useRuleSummary,
  ZoneSelectField,
} from "../../firewall/zones";
import {
  MultiSelectField,
  SegmentedField,
  SwitchField,
  TagsField,
  TextField,
  Value,
  When,
} from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { Section } from "../../kit/layout";

const RuleMatch = ({ index }: { index: number }) => {
  const summary = useRuleSummary(useWatch({ name: `firewall.rules.${index}` }));
  return (
    <Text size="sm" c="dimmed">
      {summary}
    </Text>
  );
};

const rules = defineList({
  name: "firewall.rules",
  title: "Traffic rules",
  description: "Rules apply in order, before the zones' policies.",
  addLabel: "Add rule",
  newItem: (_, intent) => ({
    name: "",
    enabled: true,
    family: "any" as const,
    protocols: ["tcp" as const, "udp" as const],
    from:
      intent.firewall.zones.find((z) => z.id === "wan")?.id ??
      intent.firewall.zones[0]?.id ??
      "*",
    to: "router",
    action: "accept" as const,
  }),
  itemTitle: (i) => (
    <Value name={`firewall.rules.${i}.name`} fallback="New rule" />
  ),
  empty: "No rules.",
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
    { header: "Match", cell: (i) => <RuleMatch index={i} /> },
    {
      header: "Action",
      width: 110,
      cell: (i) => (
        <Value
          name={`firewall.rules.${i}.action`}
          format={(a) => <PolicyBadge policy={a} />}
        />
      ),
    },
    {
      header: "Enabled",
      width: 90,
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value
            name={`firewall.rules.${i}.enabled`}
            format={(on) => (on ? "Yes" : "No")}
          />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section title="General settings">
        <TextField name={`firewall.rules.${i}.name`} label="Name" />
        <SwitchField name={`firewall.rules.${i}.enabled`} label="Enabled" />
        <SegmentedField
          name={`firewall.rules.${i}.action`}
          label="Action"
          options={policyOptions}
        />
      </Section>
      <Section title="Protocol">
        <SegmentedField
          name={`firewall.rules.${i}.family`}
          label="Restrict to address family"
          options={[
            { value: "any", label: "IPv4 and IPv6" },
            { value: "ipv4", label: "IPv4" },
            { value: "ipv6", label: "IPv6" },
          ]}
        />
        <MultiSelectField
          name={`firewall.rules.${i}.protocols`}
          label="Protocol"
          options={protocolOptions}
        />
        <When
          name={`firewall.rules.${i}.protocols`}
          test={(p?: string[]) => !!p?.includes("icmp")}
        >
          <MultiSelectField
            name={`firewall.rules.${i}.icmp_types`}
            label="Match ICMP type"
            options={icmpTypes.map((t) => ({ value: t, label: t }))}
            emptyIsUnset
            placeholder="Any"
          />
        </When>
      </Section>
      <Section title="Source">
        <ZoneSelectField
          name={`firewall.rules.${i}.from`}
          label="Source zone"
          any
        />
        <TagsField
          name={`firewall.rules.${i}.source_addresses`}
          label="Source address"
          placeholder="Any"
        />
        <TextField
          name={`firewall.rules.${i}.source_port`}
          label="Source port"
          placeholder="Any"
        />
      </Section>
      <Section title="Destination">
        <ZoneSelectField
          name={`firewall.rules.${i}.to`}
          label="Destination zone"
          description="Device (input): traffic to the router itself."
          any
          router
        />
        <TagsField
          name={`firewall.rules.${i}.destination_addresses`}
          label="Destination address"
          placeholder="Any"
        />
        <TextField
          name={`firewall.rules.${i}.destination_port`}
          label="Destination port"
          description="Like 443, 8000-8100 or 80 443."
          placeholder="Any"
        />
      </Section>
      <Section title="Advanced">
        <TextField
          name={`firewall.rules.${i}.limit`}
          label="Limit matching"
          description="At most this often, like 1000/sec."
          placeholder="Unlimited"
        />
      </Section>
    </>
  ),
});

export const RulesPage = ({ sub }: { sub: string }) => (
  <ListPage list={rules} sub={sub} />
);
