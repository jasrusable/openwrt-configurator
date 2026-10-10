import { Badge, Group, Text } from "@mantine/core";
import { useWatch } from "react-hook-form";
import { Intent } from "../../../../src/intent/schema";
import { PolicyBadge, policyOptions } from "../../firewall/zones";
import {
  MultiSelectField,
  SegmentedField,
  SwitchField,
  TextField,
  Value,
} from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { Section } from "../../kit/layout";
import { zoneLabel } from "../../../../src/intent/firewall";

/** A zone's label, live: its name, or its networks'. */
const ZoneTitle = ({ index, fallback }: { index: number; fallback: string }) => {
  const zone = useWatch({ name: `firewall.zones.${index}` }) as Intent["firewall"]["zones"][number];
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  return <>{zone ? zoneLabel(zone, networks) : fallback}</>;
};

const NetworkOptions = ({ index }: { index: number }) => {
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  return (
    <MultiSelectField
      name={`firewall.zones.${index}.networks`}
      label="Networks"
      description="Every network is in exactly one zone."
      options={networks.map((n) => ({ value: n.id, label: n.name || n.id }))}
    />
  );
};

const NetworkNames = ({ index }: { index: number }) => {
  const ids: string[] = useWatch({ name: `firewall.zones.${index}.networks` }) ?? [];
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  return (
    <Group gap={4}>
      {ids.map((id) => (
        <Badge key={id} variant="default">
          {networks.find((n) => n.id === id)?.name ?? id}
        </Badge>
      ))}
    </Group>
  );
};

const zones = defineList({
  name: "firewall.zones",
  title: "Zones",
  description:
    "A zone groups networks under one policy. Traffic between zones is set in the matrix and by rules.",
  addLabel: "Add zone",
  newItem: (zones) => ({
    id: Array.from({ length: 99 }, (_, i) => `zone${i + 1}`).find(
      (id) => !zones.some((z) => z.id === id)
    )!,
    networks: [],
    input: "reject" as const,
    forward: "reject" as const,
    output: "accept" as const,
    router_services: true,
  }),
  itemTitle: (i) => <ZoneTitle index={i} fallback="New zone" />,
  empty: "No zones.",
  columns: [
    {
      header: "Zone",
      cell: (i) => (
        <Text size="sm" fw={500}>
          <ZoneTitle index={i} fallback="Unnamed" />
        </Text>
      ),
    },
    { header: "Networks", cell: (i) => <NetworkNames index={i} /> },
    {
      header: "Input",
      cell: (i) => (
        <Value name={`firewall.zones.${i}.input`} format={(p) => <PolicyBadge policy={p} />} />
      ),
    },
    {
      header: "Forward",
      cell: (i) => (
        <Value name={`firewall.zones.${i}.forward`} format={(p) => <PolicyBadge policy={p} />} />
      ),
    },
    {
      header: "Output",
      cell: (i) => (
        <Value name={`firewall.zones.${i}.output`} format={(p) => <PolicyBadge policy={p} />} />
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField
          name={`firewall.zones.${i}.name`}
          label="Name"
          description="Optional: without one, the zone goes by its networks' names."
        />
        <NetworkOptions index={i} />
      </Section>
      <Section title="Policies" description="What happens to traffic no rule or forwarding decides.">
        <SegmentedField
          name={`firewall.zones.${i}.input`}
          label="Input"
          description="To the router itself."
          options={policyOptions}
        />
        <SegmentedField
          name={`firewall.zones.${i}.forward`}
          label="Forward"
          description="Between this zone's own networks."
          options={policyOptions}
        />
        <SegmentedField
          name={`firewall.zones.${i}.output`}
          label="Output"
          description="From the router into this zone."
          options={policyOptions}
        />
        <SwitchField
          name={`firewall.zones.${i}.router_services`}
          label="Router services"
          description="Answer DHCP, DNS and NTP even when input is not Accept."
        />
      </Section>
    </>
  ),
});

export const ZonesPage = ({ sub }: { sub: string }) => <ListPage list={zones} sub={sub} />;
