import { Badge, Text } from "@mantine/core";
import {
  parseSubnet,
  purposeAccess,
  Purpose,
} from "../../../src/intent/schema";
import {
  DurationField,
  NumberField,
  PresetField,
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
const newNetwork = (
  networks: { id: string; vlan?: number; subnet: string }[],
) => {
  const free = <T,>(candidates: T[], used: T[]) =>
    candidates.find((c) => !used.includes(c))!;
  const vlan = free(
    Array.from({ length: 400 }, (_, i) => (i + 1) * 10),
    networks.map((n) => n.vlan),
  );
  const [a, b] = parseSubnet(networks[0]?.subnet ?? "") ?? [10, 0];
  const subnet = free(
    Array.from({ length: 256 }, (_, i) => `${a}.${b}.${(vlan + i) % 256}.0/24`),
    networks.map((n) => n.subnet),
  );
  return {
    id: free(
      Array.from({ length: 99 }, (_, i) => `net${i + 2}`),
      networks.map((n) => n.id),
    ),
    name: "",
    purpose: "guest" as const,
    access: purposeAccess.guest,
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
    "Each network is kept apart from the others as its purpose says. Every port and access point carries them all.",
  addLabel: "Add network",
  newItem: newNetwork,
  canRemove: (network) => network?.vlan !== undefined,
  itemTitle: (i) => (
    <Value name={`networks.${i}.name`} fallback="New network" />
  ),
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
          <Value
            name={`networks.${i}.vlan`}
            format={(vlan) => vlan ?? "Main (untagged)"}
          />
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
        <PresetField
          name={`networks.${i}.purpose`}
          label="Purpose"
          description="Sets the access below, which you can then adjust."
          options={purposes}
          fills={`networks.${i}.access`}
          presets={purposeAccess}
        />
      </Section>
      <Section
        title="Access"
        description="Set by the purpose; adjust as needed."
      >
        <SwitchField
          name={`networks.${i}.access.internet`}
          label="Internet access"
        />
        <SwitchField
          name={`networks.${i}.access.other_networks`}
          label="Reach other networks"
          description="Devices on it can reach devices on your other networks."
        />
        <SwitchField
          name={`networks.${i}.access.isolate_clients`}
          label="Isolate Wi-Fi clients"
          description="Wi-Fi devices on the same access point and band cannot reach each other."
        />
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
        <NotMain index={i} />
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
const NotMain = ({ index }: { index: number }) => (
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
