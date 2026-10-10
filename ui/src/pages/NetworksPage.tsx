import { Badge, Text } from "@mantine/core";
import { withNetworkZone, withoutNetwork } from "../../../src/intent/edits";
import { parseSubnet, Purpose } from "../../../src/intent/schema";
import { ZoneField } from "../firewall/ZoneField";
import {
  DurationField,
  NumberField,
  SegmentedField,
  SubnetField,
  SwitchField,
  TextField,
  Value,
  When,
} from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";
import { Section, SettingRow } from "../kit/layout";

const purposes: { value: Purpose; label: string; color: string }[] = [
  { value: "home", label: "Home", color: "blue" },
  { value: "guest", label: "Guest", color: "orange" },
  { value: "iot", label: "IoT", color: "grape" },
];

/** A fresh network: the next free id, VLAN (10, 20, ...) and address range. */
const newNetwork = (networks: { id: string; vlan?: number; subnet: string }[]) => {
  const free = <T,>(candidates: T[], used: T[]) =>
    candidates.find((c) => !used.includes(c))!;
  const vlan = free(
    Array.from({ length: 400 }, (_, i) => (i + 1) * 10),
    networks.map((n) => n.vlan)
  );
  const [a, b] = parseSubnet(networks[0]?.subnet ?? "") ?? [10, 0];
  const subnet = free(
    Array.from({ length: 256 }, (_, i) => `${a}.${b}.${(vlan + i) % 256}.0/24`),
    networks.map((n) => n.subnet)
  );
  return {
    id: free(
      Array.from({ length: 99 }, (_, i) => `net${i + 2}`),
      networks.map((n) => n.id)
    ),
    name: "",
    purpose: "guest" as const,
    vlan,
    subnet,
    dhcp: { size: 100, lease: "12h" },
    ipv6: false,
  };
};

const networks = defineList({
  name: "networks",
  title: "Networks",
  description:
    "Each network is a VLAN on every port and access point, and sits in a firewall zone.",
  addLabel: "Add network",
  newItem: newNetwork,
  canRemove: (network) => network?.vlan !== undefined,
  // A new network gets its own zone from its purpose, unless put in one.
  onAdd: withNetworkZone,
  onRemove: withoutNetwork,
  itemTitle: (i) => <Value name={`networks.${i}.name`} fallback="New network" />,
  empty: "No networks yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <Text size="sm" fw={500}>
          <Value name={`networks.${i}.name`} fallback="Unnamed" />
        </Text>
      ),
    },
    {
      header: "Purpose",
      cell: (i) => (
        <Value
          name={`networks.${i}.purpose`}
          format={(purpose) => {
            const p = purposes.find((x) => x.value === purpose);
            return (
              p && (
                <Badge variant="light" color={p.color}>
                  {p.label}
                </Badge>
              )
            );
          }}
        />
      ),
    },
    {
      header: "VLAN",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value name={`networks.${i}.vlan`} format={(vlan) => vlan ?? "Main (untagged)"} />
        </Text>
      ),
    },
    {
      header: "Addresses",
      cell: (i) => (
        <Text size="sm" c="dimmed" ff="monospace">
          <Value name={`networks.${i}.subnet`} />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`networks.${i}.name`} label="Name" />
        <SegmentedField
          name={`networks.${i}.purpose`}
          label="Purpose"
          description="What it is for: sets up its firewall zone when the network is created."
          options={purposes}
        />
      </Section>
      <Section title="Firewall">
        <ZoneField index={i} />
      </Section>
      <Section title="Addressing">
        <When name={`networks.${i}.vlan`} is={undefined}>
          <SettingRow
            label="VLAN"
            description="The main network is untagged on every port; devices are managed over it."
          >
            <Text size="sm" c="dimmed">
              Main (untagged)
            </Text>
          </SettingRow>
        </When>
        <VlanField index={i} />
        <SubnetField name={`networks.${i}.subnet`} label="Addresses" />
        <SwitchField name={`networks.${i}.ipv6`} label="IPv6" />
      </Section>
      <Section title="Handing out addresses (DHCP)">
        <NumberField
          name={`networks.${i}.dhcp.size`}
          label="Addresses for devices"
          min={1}
          max={253}
        />
        <DurationField name={`networks.${i}.dhcp.lease`} label="Lease time" />
      </Section>
    </>
  ),
});

/** The VLAN field, for every network but the main one. */
const VlanField = ({ index }: { index: number }) => (
  <Value
    name={`networks.${index}.vlan`}
    format={(vlan) =>
      vlan !== undefined && (
        <NumberField
          name={`networks.${index}.vlan`}
          label="VLAN"
          description="Any switch between your devices must carry it."
          min={2}
          max={4094}
        />
      )
    }
  />
);

export const NetworksPage = () => <ListPage list={networks} />;
