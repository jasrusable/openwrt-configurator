import { Text } from "@mantine/core";
import {
  SegmentedField,
  SelectField,
  TextField,
  Value,
  When,
} from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";
import { IconAccessPoint, IconRouter } from "@tabler/icons-react";
import { useDraftValue } from "../form/draft";
import { ItemIcon, ItemName, Section } from "../kit/layout";

// Unset is automatic, so it is offered by `emptyLabel`, not listed here.
const channels = (numbers: number[]) =>
  numbers.map((n) => ({ value: n, label: `Channel ${n}` }));
const channels2g = channels([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
const channels5g = channels([
  36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132,
  136, 140, 149, 153, 157, 161, 165,
]);

const roles = [
  { value: "router" as const, label: "Router", icon: IconRouter, color: "blue" },
  { value: "access-point" as const, label: "Access point", icon: IconAccessPoint, color: "cyan" },
];

/** A router or an access point, at a glance. */
const RoleIcon = ({ index }: { index: number }) => {
  const role = roles.find((r) => r.value === useDraftValue(`hardware.${index}.role`)) ?? roles[1];
  return <ItemIcon icon={role.icon} color={role.color} />;
};

const channel = (value?: number | "auto") =>
  value === undefined || value === "auto" ? "Auto" : String(value);

const hardware = defineList({
  name: "hardware",
  title: "Hardware",
  description:
    "Your router and access points.",
  addLabel: "Add access point",
  newItem: () => ({ name: "", role: "access-point" as const }),
  itemTitle: (i) => <Value name={`hardware.${i}.name`} fallback="New access point" />,
  empty: "No hardware yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <ItemName icon={<RoleIcon index={i} />}>
          <Value name={`hardware.${i}.name`} fallback="Unnamed" />
        </ItemName>
      ),
    },
    {
      header: "Role",
      cell: (i) => (
        <Value
          name={`hardware.${i}.role`}
          format={(role) => (
            <Text size="sm" c="dimmed">
              {roles.find((r) => r.value === role)?.label}
            </Text>
          )}
        />
      ),
    },
    {
      header: "Channels",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value
            name={`hardware.${i}`}
            format={(device) =>
              device?.role === "access-point"
                ? `${channel(device.wifi?.channel?.["2g"])} · ${channel(
                    device.wifi?.channel?.["5g"],
                  )}`
                : "—"
            }
          />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField
          name={`hardware.${i}.name`}
          label="Name"
          description="Also its hostname."
        />
        <SegmentedField
          name={`hardware.${i}.role`}
          label="Role"
          description="The router runs the networks; access points broadcast Wi-Fi."
          options={roles}
        />
        <TextField
          name={`hardware.${i}.location`}
          label="Location"
          description="Where it is, for you: shown in LuCI too."
          placeholder="Living room"
        />
      </Section>
      <When name={`hardware.${i}.role`} is="access-point">
        <Section
          title="Wi-Fi"
          description="Pin one only to avoid a crowded channel."
        >
          <SelectField
            name={`hardware.${i}.wifi.channel.2g`}
            label="2.4 GHz channel"
            options={channels2g}
            emptyLabel="Automatic"
          />
          <SelectField
            name={`hardware.${i}.wifi.channel.5g`}
            label="5 GHz channel"
            options={channels5g}
            emptyLabel="Automatic"
          />
        </Section>
      </When>
    </>
  ),
});

export const HardwarePage = () => <ListPage list={hardware} />;
