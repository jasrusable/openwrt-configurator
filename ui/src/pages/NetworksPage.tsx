import {
  ActionIcon,
  Badge,
  Button,
  Group,
  NumberInput,
  Text,
  TextInput,
} from "@mantine/core";
import { IconPlus, IconX } from "@tabler/icons-react";
import { useDraft, useDraftValue, useFieldError } from "../form/draft";
import { withNetworkAdded, withoutNetwork } from "../../../src/intent/edits";
import {
  allowed,
  reachableNetworks,
} from "../../../src/intent/choices";
import { accessForPurpose } from "../../../src/intent/firewall";
import { deviceOf } from "../../../src/intent/features/network";
import { Intent, parseSubnet, Purpose } from "../../../src/intent/schema";
import {
  DurationField,
  MultiSelectField,
  NumberField,
  OptionalField,
  PresetField,
  SegmentedField,
  SubnetField,
  SwitchField,
  TagsField,
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
    purpose: "guest" as const,
    vlan,
    subnet,
    dhcp: { size: 100, lease: "12h" },
    // As the internet side has it.
    ipv6: intent.internet.ipv6,
    access: accessForPurpose("guest", []),
    reservations: [],
    share_devices: false,
  };
};

const networks = defineList({
  name: "networks",
  title: "Networks",
  description:
    "Each network is a VLAN on every port and access point, with its own access to the internet, the router and the others.",
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
        <NameField index={i} />
        <PurposeField index={i} />
      </Section>
      <AccessSection index={i} />
      <ReservationsSection index={i} />
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
          description="Devices ask these instead of the router, e.g. a Pi-hole. They then skip encrypted DNS and local names."
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

/** Picking a purpose sets the network's access, which stays adjustable. */
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

const PurposeField = ({ index }: { index: number }) => {
  const intent: Intent = useDraftValue();
  const others = reachableNetworks(intent.networks ?? [], index);
  // Only what the network may have (the rules): the main one keeps full router access.
  const preset = (purpose: Purpose) => {
    const access = accessForPurpose(purpose, others);
    return allowed(intent, `networks.${index}.access.router`, access.router)
      ? access
      : { ...access, router: "full" as const };
  };
  return (
    <PresetField
      name={`networks.${index}.purpose`}
      label="Purpose"
      description="Sets its access below: home reaches everything, guests and IoT only the internet."
      options={purposes}
      fills={`networks.${index}.access`}
      presets={{
        home: preset("home"),
        guest: preset("guest"),
        iot: preset("iot"),
      }}
    />
  );
};

const AccessSection = ({ index }: { index: number }) => {
  const reachable = useReachable(index);
  const networks: Intent["networks"] = useDraftValue("networks") ?? [];
  return (
    <Section
      title="Access"
      description="Replies always get back, so a network that may not reach this one can still answer it. Exceptions: Firewall › Rules."
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
            ? "Nothing to share with yet: turn it on for another network too."
            : "AirPlay, printers and Chromecasts are seen on the other networks that share theirs. Using one still needs Can reach."
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
        description="Network services: addresses, DNS and time only. Full: also the router's admin pages and SSH."
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
      description={`These devices always get the same address, and a name: name.${domain}. Rules and port forwards that point at a device need one.`}
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
        <Text size="sm" c="dimmed" ta="center" py="md">
          No reserved addresses.
        </Text>
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
