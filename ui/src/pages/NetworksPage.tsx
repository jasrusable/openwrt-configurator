import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Text,
  TextInput,
} from "@mantine/core";
import {
  IconAddressBook,
  IconAdjustmentsHorizontal,
  IconBulb,
  IconHome,
  IconPlus,
  IconUsers,
  IconX,
} from "@tabler/icons-react";
import { useDraft, useDraftValue, useFieldError } from "../form/draft";
import { withNetworkAdded, withoutNetwork } from "../../../src/intent/edits";
import {
  availability,
  reachableNetworks,
} from "../../../src/intent/choices";
import {
  NetworkTemplate,
  templateOf,
  templateSettings,
  withTemplate,
} from "../../../src/intent/networkTemplates";
import { deviceOf } from "../../../src/intent/features/network";
import { where } from "../../../src/intent/places";
import { Intent, parseSubnet } from "../../../src/intent/schema";
import {
  DurationField,
  MultiSelectField,
  NumberField,
  OptionalField,
  segments,
  SegmentedField,
  SubnetField,
  SwitchField,
  TagsField,
  TextField,
  Value,
  When,
} from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";
import { EmptyState, ItemIcon, ItemName, Section, SettingRow } from "../kit/layout";

/** Each template, and Custom for a network that follows none (networkTemplates.ts). */
const types: {
  value: NetworkTemplate | "custom";
  label: string;
  color: string;
  icon: typeof IconHome;
}[] = [
  { value: "home", label: "Home", color: "blue", icon: IconHome },
  { value: "guest", label: "Guest", color: "orange", icon: IconUsers },
  { value: "iot", label: "IoT", color: "grape", icon: IconBulb },
  { value: "custom", label: "Custom", color: "gray", icon: IconAdjustmentsHorizontal },
];

/** Which template network `index` follows, read off its settings. */
const useType = (index: number) => {
  const networks: Intent["networks"] = useDraftValue("networks") ?? [];
  return types.find((t) => t.value === templateOf(networks, index)) ?? types[3];
};

/** A network's type, at a glance. */
const TypeIcon = ({ index }: { index: number }) => {
  const type = useType(index);
  return <ItemIcon icon={type.icon} color={type.color} />;
};

/** A fresh network: the next free id, VLAN (10, 20, ...) and address range. */
const newNetwork = (
  networks: { id: string; vlan?: number; subnet: string }[],
  intent: Intent,
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
    vlan,
    subnet,
    dhcp: { size: 100, lease: "12h" },
    // As the internet side has it.
    ipv6: intent.internet.ipv6,
    reservations: [],
    ...templateSettings("guest", []),
  };
};

const networks = defineList({
  name: "networks",
  title: "Networks",
  description:
    "Each network is a VLAN with its own access.",
  addLabel: "Add network",
  newItem: newNetwork,
  canRemove: (network) => network?.vlan !== undefined,
  // Home networks reach a new network, as they reach the rest.
  onAdd: withNetworkAdded,
  onRemove: withoutNetwork,
  itemTitle: (i) => (
    <Value name={`networks.${i}.name`} fallback="New network" />
  ),
  empty: "No networks yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <ItemName icon={<TypeIcon index={i} />}>
          <Value name={`networks.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    {
      header: "Type",
      cell: (i) => <TypeLabel index={i} />,
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
        <NameField index={i} />
        <TypeField index={i} />
      </Section>
      <AccessSection index={i} />
      <ReservationsSection index={i} />
      <Section title="Addressing">
        <When name={`networks.${i}.vlan`} is={undefined}>
          <SettingRow
            label="VLAN"
            description="Untagged on every port; devices are managed over it."
          >
            <Text size="sm" c="dimmed">
              Main (untagged)
            </Text>
          </SettingRow>
        </When>
        <VlanField index={i} />
        <SubnetField name={`networks.${i}.subnet`} label="Router address" />
        <Ipv6Field index={i} />
      </Section>
      <Section title="Handing out addresses (DHCP)">
        <NumberField
          name={`networks.${i}.dhcp.size`}
          label="Addresses for devices"
          min={1}
          max={253}
        />
        <DurationField name={`networks.${i}.dhcp.lease`} label="Lease time" />
        <OptionalField
          name={`networks.${i}.dhcp.dns_servers`}
          label="Hand out other DNS servers"
          description="Instead of the router, e.g. a Pi-hole."
          initial={[]}
        >
          <TagsField
            name={`networks.${i}.dhcp.dns_servers`}
            label="DNS servers"
            placeholder="10.0.0.53"
          />
        </OptionalField>
      </Section>
    </>
  ),
});

/** The networks network `index` may be given access to, by name. */
const useReachable = (index: number) => {
  const networks: Intent["networks"] = useDraftValue("networks") ?? [];
  const ids = reachableNetworks(networks, index);
  return networks
    .filter((n) => ids.includes(n.id))
    .map((n) => ({ value: n.id, label: n.name || "Unnamed" }));
};

/** Its name, with what it is called on the devices: what to look for in LuCI or over SSH. */
const NameField = ({ index }: { index: number }) => {
  const network: Intent["networks"][number] | undefined = useDraftValue(`networks.${index}`);
  return (
    <TextField
      name={`networks.${index}.name`}
      label="Name"
      openwrt={network?.id ? `interface ${network.id} on ${deviceOf(network)}` : undefined}
    />
  );
};

const TypeLabel = ({ index }: { index: number }) => (
  <Text size="sm" c="dimmed">
    {useType(index).label}
  </Text>
);

/**
 * Home, Guest or IoT fill in its access and sharing below, which stay
 * adjustable; changed by hand, it reads Custom. Nothing is stored: the
 * selection is read off the settings, so it never disagrees with them.
 */
const TypeField = ({ index }: { index: number }) => {
  const draft = useDraft();
  const intent: Intent = useDraftValue();
  const current = useType(index);
  // The main network keeps full router access: Guest and IoT would take it away.
  const servicesOnly = availability(intent, `networks.${index}.access.router`).option("services").unavailable;
  return (
    <SettingRow label="Type" description="Fills in its access and sharing; Custom once you change them.">
      <SegmentedControl
        value={current.value}
        onChange={(value) => {
          if (value !== "custom") draft.replace(withTemplate(draft.get(), index, value as NetworkTemplate));
        }}
        data={segments(
          types.map(({ value, label }) => ({
            value,
            label,
            // Custom is not chosen but reached: by changing access or sharing below.
            disabled:
              (value === "custom" && current.value !== "custom") ||
              ((value === "guest" || value === "iot") && !!servicesOnly),
            reason:
              value === "custom"
                ? current.value === "custom"
                  ? "Its access and sharing follow no template."
                  : "Change its access or sharing below, and it becomes Custom."
                : (value === "guest" || value === "iot") && servicesOnly
                ? servicesOnly
                : undefined,
          }))
        )}
      />
    </SettingRow>
  );
};

const AccessSection = ({ index }: { index: number }) => {
  const reachable = useReachable(index);
  const networks: Intent["networks"] = useDraftValue("networks") ?? [];
  return (
    <Section
      title="Access"
      description={`Replies always get back. Exceptions: ${where("rules")}.`}
    >
      <SwitchField
        name={`networks.${index}.access.internet`}
        label="Internet"
      />
      <SwitchField
        name={`networks.${index}.share_devices`}
        label="Share devices with other networks"
        description={
          networks[index]?.share_devices &&
          !networks.some((n, i) => i !== index && n.share_devices)
            ? "Turn it on for another network too."
            : "AirPlay, printers and Chromecasts, seen across networks."
        }
      />
      <MultiSelectField
        name={`networks.${index}.access.networks`}
        label="Can reach"
        description="Other networks its devices may connect to."
        options={reachable}
        placeholder={reachable.length ? "None" : "No other networks"}
      />
      <SegmentedField
        name={`networks.${index}.access.router`}
        label="Router access"
        description="Services: addresses, DNS and time. Full: also admin and SSH."
        options={[
          { value: "services", label: "Network services" },
          { value: "full", label: "Full" },
        ]}
      />
    </Section>
  );
};

/** Greyed out without the internet's IPv6, or when its prefix is full, with why (choices.ts). */
const Ipv6Field = ({ index }: { index: number }) => (
  <SwitchField name={`networks.${index}.ipv6`} label="IPv6" />
);

/** 12 hex digits, however typed (AA-BB-..., aabb...), as aa:bb:cc:dd:ee:ff. */
const tidyMac = (typed: string) => {
  const kept = typed.toLowerCase().replace(/[^0-9a-f:-]/g, "");
  const hex = kept.replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex.match(/../g)!.join(":") : kept;
};

/** Devices that always get the same address on this network, and a name in DNS. */
const ReservationsSection = ({ index }: { index: number }) => {
  const draft = useDraft();
  const base = `networks.${index}.reservations`;
  const reservations: Reservation[] = useDraftValue(base as never) ?? [];
  const subnet: string = useDraftValue(`networks.${index}.subnet`) ?? "";
  const prefix = subnet.split(".").slice(0, 3).join(".");
  const domain: string = useDraftValue("dns.local_domain") ?? "lan";
  const set = (next: Reservation[]) => draft.set(base, next);
  const used = reservations.map((r) => Number(r.address.split(".")[3]));
  return (
    <Section
      title="Reserved addresses"
      description={`The same address every time, and a name: name.${domain}.`}
      actions={
        <Button
          variant="subtle"
          size="compact-sm"
          leftSection={<IconPlus size={14} />}
          onClick={() => {
            const host =
              Array.from({ length: 235 }, (_, i) => i + 20).find(
                (h) => !used.includes(h),
              ) ?? 2;
            set([
              ...reservations,
              { name: "", mac: "", address: `${prefix}.${host}` },
            ]);
          }}
        >
          Add device
        </Button>
      }
    >
      {reservations.length === 0 ? (
        <EmptyState icon={IconAddressBook}>No reserved addresses.</EmptyState>
      ) : (
        <>
          <Group gap="xs" px="md" pt="sm" wrap="nowrap">
            {[
              ["Name", 1],
              ["MAC address", 1.3],
              ["Address", 1.2],
            ].map(([label, flex]) => (
              <Text
                key={label}
                size="xs"
                c="dimmed"
                fw={500}
                style={{ flex: flex as number }}
              >
                {label}
              </Text>
            ))}
            <div style={{ width: 36 }} />
          </Group>
          {reservations.map((r, j) => (
            <ReservationRow
              key={j}
              path={`${base}.${j}`}
              reservation={r}
              prefix={prefix}
              onChange={(next) =>
                set(reservations.map((old, k) => (k === j ? next : old)))
              }
              onRemove={() => set(reservations.filter((_, k) => k !== j))}
            />
          ))}
        </>
      )}
    </Section>
  );
};

type Reservation = { name: string; mac: string; address: string };

const ReservationRow = ({
  path,
  reservation: r,
  prefix,
  onChange,
  onRemove,
}: {
  path: string;
  reservation: Reservation;
  prefix: string;
  onChange: (next: Reservation) => void;
  onRemove: () => void;
}) => {
  const errors = {
    name: useFieldError(`${path}.name`),
    mac: useFieldError(`${path}.mac`),
    address: useFieldError(`${path}.address`),
  };
  const host = r.address.startsWith(`${prefix}.`)
    ? r.address.split(".")[3]
    : "";
  return (
    <Group gap="xs" px="md" py="sm" wrap="nowrap" align="flex-start">
      <TextInput
        placeholder="nas"
        aria-label="Name"
        value={r.name}
        onChange={(e) =>
          onChange({
            ...r,
            name: e.currentTarget.value
              .toLowerCase()
              .replace(/[^a-z0-9-]/g, ""),
          })
        }
        error={errors.name}
        spellCheck={false}
        style={{ flex: 1 }}
      />
      <TextInput
        placeholder="aa:bb:cc:dd:ee:ff"
        aria-label="MAC address"
        value={r.mac}
        onChange={(e) =>
          onChange({ ...r, mac: tidyMac(e.currentTarget.value) })
        }
        error={errors.mac}
        spellCheck={false}
        ff="monospace"
        style={{ flex: 1.3 }}
      />
      <NumberInput
        aria-label="Address"
        leftSection={
          <Text size="sm" c="dimmed" ff="monospace">
            {prefix}.
          </Text>
        }
        leftSectionWidth={prefix.length * 8 + 16}
        value={host === "" ? "" : Number(host)}
        min={2}
        max={254}
        clampBehavior="strict"
        allowDecimal={false}
        allowNegative={false}
        hideControls
        onChange={(n) => onChange({ ...r, address: `${prefix}.${n}` })}
        error={errors.address}
        ff="monospace"
        style={{ flex: 1.2 }}
      />
      <ActionIcon
        variant="subtle"
        color="gray"
        size={36}
        onClick={onRemove}
        aria-label="Remove"
      >
        <IconX size={16} />
      </ActionIcon>
    </Group>
  );
};

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
