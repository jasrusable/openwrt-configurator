// LuCI's Network › Firewall › General Settings: the defaults, then the zones,
// each as "zone ⇒ the zones it forwards to", opening the zone's editor.
import { Badge, Group, Text } from "@mantine/core";
import { useWatch } from "react-hook-form";
import { withoutZone } from "../../../../src/intent/edits";
import { wanZone, zoneLabel } from "../../../../src/intent/firewall";
import { Intent } from "../../../../src/intent/schema";
import { ForwardingsField } from "../../firewall/ForwardingsField";
import { PolicyBadge, policyOptions } from "../../firewall/zones";
import {
  MultiSelectField,
  SegmentedField,
  SwitchField,
  TextField,
  Value,
  When,
} from "../../form/fields";
import { defineList, ListPage } from "../../form/ListPage";
import { Section, SettingRow } from "../../kit/layout";

/** A zone's label, live: its name, or its networks'. */
const ZoneTitle = ({
  index,
  fallback,
}: {
  index: number;
  fallback: string;
}) => {
  const zone = useWatch({ name: `firewall.zones.${index}` }) as
    | Intent["firewall"]["zones"][number]
    | undefined;
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  return <>{zone ? zoneLabel(zone, networks) : fallback}</>;
};

/** "Home ⇒ WAN, Guests": the zone, and the zones it forwards to. */
const ZoneForwardings = ({ index }: { index: number }) => {
  const zones: Intent["firewall"]["zones"] =
    useWatch({ name: "firewall.zones" }) ?? [];
  const forwardings: Intent["firewall"]["forwardings"] =
    useWatch({ name: "firewall.forwardings" }) ?? [];
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  const zone = zones[index];
  if (!zone) return null;
  const label = (id: string) => {
    const z = zones.find((x) => x.id === id);
    return z ? zoneLabel(z, networks) : id;
  };
  const targets = forwardings
    .filter((f) => f.from === zone.id)
    .map((f) => f.to);
  return (
    <Group gap={6} wrap="nowrap">
      <Badge variant="filled" color={zone.id === wanZone ? "red" : "blue"}>
        {label(zone.id)}
      </Badge>
      <Text c="dimmed">⇒</Text>
      {targets.length ? (
        targets.map((id) => (
          <Badge
            key={id}
            variant="light"
            color={id === wanZone ? "red" : "blue"}
          >
            {label(id)}
          </Badge>
        ))
      ) : (
        <Text size="sm" c="dimmed">
          reject
        </Text>
      )}
    </Group>
  );
};

const NetworksField = ({ index }: { index: number }) => {
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  return (
    <MultiSelectField
      name={`firewall.zones.${index}.networks`}
      label="Covered networks"
      description="Every network is in exactly one zone."
      options={networks.map((n) => ({ value: n.id, label: n.name || n.id }))}
    />
  );
};

const zones = defineList({
  name: "firewall.zones",
  title: "Zones",
  addLabel: "Add zone",
  newItem: (zones) => ({
    id: Array.from({ length: 99 }, (_, i) => `zone${i + 1}`).find(
      (id) => !zones.some((z) => z.id === id),
    )!,
    networks: [],
    input: "reject" as const,
    output: "accept" as const,
    forward: "reject" as const,
    masquerade: false,
    mss_clamping: false,
  }),
  canRemove: (zone) => zone?.id !== wanZone,
  // As LuCI deletes a zone: with the forwardings and rules naming it.
  onRemove: withoutZone,
  itemTitle: (i) => <ZoneTitle index={i} fallback="New zone" />,
  empty: "No zones.",
  columns: [
    {
      header: "Zone ⇒ Forwardings",
      cell: (i) => <ZoneForwardings index={i} />,
    },
    {
      header: "Input",
      cell: (i) => (
        <Value
          name={`firewall.zones.${i}.input`}
          format={(p) => <PolicyBadge policy={p} />}
        />
      ),
    },
    {
      header: "Output",
      cell: (i) => (
        <Value
          name={`firewall.zones.${i}.output`}
          format={(p) => <PolicyBadge policy={p} />}
        />
      ),
    },
    {
      header: "Forward",
      cell: (i) => (
        <Value
          name={`firewall.zones.${i}.forward`}
          format={(p) => <PolicyBadge policy={p} />}
        />
      ),
    },
    {
      header: "Masquerading",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value
            name={`firewall.zones.${i}.masquerade`}
            format={(on) => (on ? "✓" : "—")}
          />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section title="General settings">
        <TextField
          name={`firewall.zones.${i}.name`}
          label="Name"
          description="Optional: without one, the zone goes by its networks' names."
        />
        <SegmentedField
          name={`firewall.zones.${i}.input`}
          label="Input"
          options={policyOptions}
        />
        <SegmentedField
          name={`firewall.zones.${i}.output`}
          label="Output"
          options={policyOptions}
        />
        <SegmentedField
          name={`firewall.zones.${i}.forward`}
          label="Forward"
          description="Between this zone's own networks."
          options={policyOptions}
        />
        <SwitchField
          name={`firewall.zones.${i}.masquerade`}
          label="Masquerading"
        />
        <SwitchField
          name={`firewall.zones.${i}.mss_clamping`}
          label="MSS clamping"
        />
        <When name={`firewall.zones.${i}.id`} test={(id) => id === wanZone}>
          <SettingRow label="Covered networks">
            <Text size="sm" c="dimmed">
              The internet connection
            </Text>
          </SettingRow>
        </When>
        <When name={`firewall.zones.${i}.id`} test={(id) => id !== wanZone}>
          <NetworksField index={i} />
        </When>
      </Section>
      <Section
        title="Inter-zone forwarding"
        description="Forwardings let traffic between zones; anything else is up to the source zone's policy and the rules."
      >
        <ForwardingsField
          index={i}
          direction="to"
          label="Allow forward to destination zones"
        />
        <ForwardingsField
          index={i}
          direction="from"
          label="Allow forward from source zones"
        />
      </Section>
    </>
  ),
});

const Defaults = () => (
  <Section title="General settings">
    <SwitchField
      name="firewall.defaults.syn_flood_protection"
      label="Enable SYN-flood protection"
    />
    <SwitchField
      name="firewall.defaults.drop_invalid"
      label="Drop invalid packets"
    />
    <SegmentedField
      name="firewall.defaults.input"
      label="Input"
      options={policyOptions}
    />
    <SegmentedField
      name="firewall.defaults.output"
      label="Output"
      options={policyOptions}
    />
    <SegmentedField
      name="firewall.defaults.forward"
      label="Forward"
      options={policyOptions}
    />
  </Section>
);

export const GeneralSettingsPage = ({ sub }: { sub: string }) => (
  <ListPage
    list={zones}
    sub={sub}
    base="/firewall/zones"
    page={{
      title: "Firewall",
      description:
        "Zones group your networks; forwardings and rules decide what passes between them.",
      before: <Defaults />,
    }}
  />
);
