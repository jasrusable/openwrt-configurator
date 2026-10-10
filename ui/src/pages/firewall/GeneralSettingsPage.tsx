// LuCI's Network › Firewall › General Settings: the defaults, then the zones,
// each as "zone ⇒ the zones it forwards to", opening the zone's editor.
import { Badge, Group, Stack, Text } from "@mantine/core";
import { useWatch } from "react-hook-form";
import { withoutZone } from "../../../../src/intent/edits";
import { wanZone, zoneLabel } from "../../../../src/intent/firewall";
import { Intent } from "../../../../src/intent/schema";
import { ForwardingsField } from "../../firewall/ForwardingsField";
import { policyOptions } from "../../firewall/zones";
import {
  MultiSelectField,
  SegmentedField,
  SelectField,
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

/** LuCI's colours: WAN red, the main zone green, the rest a tint by name. */
const zoneColor = (id: string, mainZone?: string) =>
  id === wanZone
    ? "red"
    : id === mainZone
      ? "green"
      : ["blue", "grape", "orange", "teal", "pink", "yellow"][
          [...id].reduce((sum, c) => sum + c.charCodeAt(0), 0) % 6
        ];

const ZoneBadge = ({
  id,
  label,
  main,
}: {
  id: string;
  label: string;
  main?: string;
}) => (
  <Badge variant="light" color={zoneColor(id, main)} radius="sm">
    {label}
  </Badge>
);

/**
 * LuCI's "zone ⇒ forwards": the zone, the zones it forwards to, and what
 * happens to the rest (the default forward policy), in a dashed box.
 */
const ZoneForwardings = ({ index }: { index: number }) => {
  const zones: Intent["firewall"]["zones"] =
    useWatch({ name: "firewall.zones" }) ?? [];
  const forwardings: Intent["firewall"]["forwardings"] =
    useWatch({ name: "firewall.forwardings" }) ?? [];
  const networks: Intent["networks"] = useWatch({ name: "networks" }) ?? [];
  const fallback: string =
    useWatch({ name: "firewall.defaults.forward" }) ?? "reject";
  const zone = zones[index];
  if (!zone) return null;
  const mainNetwork = networks.find((n) => n.vlan === undefined)?.id ?? "";
  const main = zones.find((z) => z.networks.includes(mainNetwork))?.id;
  const label = (id: string) => {
    const z = zones.find((x) => x.id === id);
    return z ? zoneLabel(z, networks) : id;
  };
  const targets = forwardings
    .filter((f) => f.from === zone.id)
    .map((f) => f.to);
  return (
    <Group gap={8} wrap="nowrap" align="flex-start">
      <ZoneBadge id={zone.id} label={label(zone.id)} main={main} />
      <Text c="dimmed">⇒</Text>
      <Stack gap={4}>
        {targets.map((id) => (
          <ZoneBadge key={id} id={id} label={label(id)} main={main} />
        ))}
        <Text
          size="xs"
          fs="italic"
          c="dimmed"
          px={6}
          style={{
            border: "1px dashed var(--mantine-color-gray-4)",
            borderRadius: 4,
          }}
        >
          {fallback.toUpperCase()}
          {targets.length ? " all others" : ""}
        </Text>
      </Stack>
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
  // As LuCI's zones table: policies and masquerading edited in place.
  columns: [
    { header: "Zone ⇒ Forwards", cell: (i) => <ZoneForwardings index={i} /> },
    ...(["input", "output", "forward"] as const).map((policy) => ({
      header:
        policy === "forward"
          ? "Intra zone forward"
          : policy === "input"
            ? "Input"
            : "Output",
      interactive: true,
      width: 150,
      cell: (i: number) => (
        <SelectField
          inline
          name={`firewall.zones.${i}.${policy}`}
          label={policy}
          options={policyOptions}
        />
      ),
    })),
    {
      header: "IPv4 Masquerading",
      interactive: true,
      width: 140,
      cell: (i) => (
        <SwitchField
          inline
          name={`firewall.zones.${i}.masquerade`}
          label="Masquerading"
        />
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
