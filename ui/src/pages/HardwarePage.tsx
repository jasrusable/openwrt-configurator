import { Button, Text } from "@mantine/core";
import {
  SegmentedField,
  SelectField,
  TextField,
  Value,
  When,
} from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";
import { IconAccessPoint, IconRefresh, IconRouter } from "@tabler/icons-react";
import { useDraftValue } from "../form/draft";
import { useDeviceFacts, useReadDevices } from "../data/devices";
import { ago, bandsOf, modelOf, portsOf } from "../facts";
import { ItemIcon, ItemName, Section, SettingRow } from "../kit/layout";
import { notify } from "../kit/notify";

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

/** Reads every device now: read-only over SSH, and only when pressed. */
const ReadDevicesButton = () => {
  const read = useReadDevices();
  return (
    <Button
      variant="default"
      leftSection={<IconRefresh size={16} />}
      loading={read.isPending}
      title="Reads each device's model, OpenWrt version, ports and radios over SSH. Changes nothing."
      onClick={() =>
        read.mutate(undefined, {
          onSuccess: ({ results }) => {
            const failed = results.filter((r) => !r.ok);
            if (failed.length === 0) notify.success(`Read ${results.length} device${results.length === 1 ? "" : "s"}.`);
            else failed.forEach((r) => !r.ok && notify.error(`${r.hostname}: ${r.error}`));
          },
          onError: (e) => notify.error((e as Error).message),
        })
      }
    >
      Read from devices
    </Button>
  );
};

/** A device's name and what it is, as last read. */
const useFactsOf = (index: number) => {
  const name: string | undefined = useDraftValue(`hardware.${index}.name`);
  const facts = useDeviceFacts().data;
  return name ? facts?.[name] : undefined;
};

const ModelCell = ({ index }: { index: number }) => {
  const known = useFactsOf(index);
  return (
    <Text size="sm" c="dimmed" truncate>
      {known ? modelOf(known.schema) : "Not read yet"}
    </Text>
  );
};

/** What the device is, read from it: nothing here is set by you. */
const DeviceFacts = ({ index }: { index: number }) => {
  const known = useFactsOf(index);
  if (!known) {
    return (
      <Section title="Device" description="Read from devices to see its model, OpenWrt version, ports and radios.">
        <SettingRow label="Not read yet" />
      </Section>
    );
  }
  const { schema, readAt } = known;
  const ports = portsOf(schema);
  const bands = bandsOf(schema);
  return (
    <Section title="Device" description={`Read from the device ${ago(readAt)}.`}>
      <SettingRow label="Model">
        <Text size="sm" c="dimmed">{modelOf(schema)}</Text>
      </SettingRow>
      <SettingRow label="OpenWrt">
        <Text size="sm" c="dimmed">{schema.version}</Text>
      </SettingRow>
      {ports.wan.length > 0 && (
        <SettingRow label="Internet port" openwrt="wan">
          <Text size="sm" c="dimmed" ff="monospace">{ports.wan.join(", ")}</Text>
        </SettingRow>
      )}
      <SettingRow label="Network ports" openwrt="lan">
        <Text size="sm" c="dimmed" ff="monospace">{ports.lan.join(", ") || "—"}</Text>
      </SettingRow>
      <SettingRow label="Wi-Fi">
        <Text size="sm" c="dimmed">{bands.length ? bands.join(", ") : "None"}</Text>
      </SettingRow>
    </Section>
  );
};

const hardware = defineList({
  name: "hardware",
  title: "Hardware",
  description:
    "Your router and access points.",
  addLabel: "Add access point",
  actions: <ReadDevicesButton />,
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
    { header: "Model", cell: (i) => <ModelCell index={i} /> },
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
      <DeviceFacts index={i} />
    </>
  ),
});

export const HardwarePage = () => <ListPage list={hardware} />;
