import { Badge, Text } from "@mantine/core";
import { SegmentedField, SelectField, TextField, Value, When } from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";

// Unset is automatic, so it is offered by `emptyLabel`, not listed here.
const channels = (numbers: number[]) =>
  numbers.map((n) => ({ value: n, label: `Channel ${n}` }));
const channels2g = channels([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
const channels5g = channels([
  36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132,
  136, 140, 149, 153, 157, 161, 165,
]);

const roles = [
  { value: "router" as const, label: "Router" },
  { value: "access-point" as const, label: "Access point" },
];

const channel = (value?: number | "auto") =>
  value === undefined || value === "auto" ? "Auto" : String(value);

const devices = defineList({
  name: "devices",
  title: "Devices",
  description: "Your router and access points. Each is set up entirely from these settings.",
  addLabel: "Add device",
  newItem: () => ({ name: "", role: "access-point" as const }),
  itemTitle: (i) => <Value name={`devices.${i}.name`} fallback="New device" />,
  empty: "No devices yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <Text size="sm" fw={500}>
          <Value name={`devices.${i}.name`} fallback="Unnamed" />
        </Text>
      ),
    },
    {
      header: "Role",
      cell: (i) => (
        <Value
          name={`devices.${i}.role`}
          format={(role) => (
            <Badge variant="light" color={role === "router" ? "blue" : "gray"}>
              {roles.find((r) => r.value === role)?.label}
            </Badge>
          )}
        />
      ),
    },
    {
      header: "Channels",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value
            name={`devices.${i}`}
            format={(device) =>
              device?.role === "access-point"
                ? `${channel(device.wifi?.channel?.["2g"])} · ${channel(
                    device.wifi?.channel?.["5g"]
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
      <TextField name={`devices.${i}.name`} label="Name" description="Also its hostname." />
      <SegmentedField name={`devices.${i}.role`} label="Role" options={roles} />
      <When name={`devices.${i}.role`} is="access-point">
        <SelectField
          name={`devices.${i}.wifi.channel.2g`}
          label="2.4 GHz channel"
          options={channels2g}
          emptyLabel="Automatic"
        />
        <SelectField
          name={`devices.${i}.wifi.channel.5g`}
          label="5 GHz channel"
          options={channels5g}
          emptyLabel="Automatic"
        />
      </When>
    </>
  ),
});

export const DevicesPage = () => <ListPage list={devices} />;
