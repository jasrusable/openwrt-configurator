import { Group, Text } from "@mantine/core";
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
import { useFreshDevices } from "../data/devices";
import { AddHardwarePage } from "./AddHardwarePage";
import { useNetworkStatus } from "../data/status";
import { ago, bandsOf, duration, modelOf, portsOf } from "../facts";
import { ItemIcon, ItemName, Section, SettingRow, StatusDot } from "../kit/layout";

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

/** What device `index` is as last read, whether its last read failed, and whether one is under way. */
const useFactsOf = (index: number) => {
  const name: string | undefined = useDraftValue(`hardware.${index}.name`);
  const devices = useFreshDevices();
  const known = name ? devices.data?.facts[name] : undefined;
  const failed = name ? devices.data?.failures[name] : undefined;
  // A failure newer than the facts: the device was not reached last time.
  const unreached = failed && (!known || failed.at > known.readAt) ? failed : undefined;
  return { known, unreached, reading: devices.reading };
};

/**
 * Device `index` online, offline or not known yet, from the live status read
 * while the page is open; the list and the device's page say it the same way.
 */
const useOnline = (index: number) => {
  const name: string | undefined = useDraftValue(`hardware.${index}.name`);
  const now = useNetworkStatus().data?.devices.find((d) => d.name === name);
  const health = now?.health;
  return !now
    ? { color: "gray" as const, label: "Checking…" }
    : health
    ? {
        color: "green" as const,
        label: "Online",
        detail: `Up ${duration(health.uptime)} · load ${health.load.toFixed(2)} · memory ${Math.round(health.memoryUsed * 100)}%`,
      }
    : { color: "orange" as const, label: "Offline", detail: `Not reached: ${now.error}` };
};

const Online = ({ index }: { index: number }) => {
  const { color, label, detail } = useOnline(index);
  return (
    <Group gap={6} wrap="nowrap" title={detail}>
      <StatusDot color={color} />
      <Text size="sm" c="dimmed">
        {label}
      </Text>
    </Group>
  );
};

const StatusRow = ({ index }: { index: number }) => (
  <SettingRow label="Status" description={useOnline(index).detail}>
    <Online index={index} />
  </SettingRow>
);

const ModelCell = ({ index }: { index: number }) => {
  const { known, unreached, reading } = useFactsOf(index);
  return (
    <Text size="sm" c="dimmed" truncate>
      {known ? modelOf(known.schema) : reading ? "Reading…" : unreached ? "Not reached" : "—"}
    </Text>
  );
};

/** What the device is, read from it: nothing here is set by you. */
const DeviceFacts = ({ index }: { index: number }) => {
  const { known, unreached, reading } = useFactsOf(index);
  // Read from the device by itself; said in words, never a button.
  const note = reading
    ? "Reading from the device…"
    : unreached
    ? `Couldn't reach it ${ago(unreached.at)}: ${unreached.error}. Tried again in a while.`
    : known
    ? `Read from the device ${ago(known.readAt)}.`
    : undefined;
  if (!known) {
    return (
      <Section title="Device" description={note}>
        <StatusRow index={index} />
        <SettingRow
          label={reading ? "Reading…" : "Not read yet"}
          description="Its model, OpenWrt version, ports and radios, once it can be reached."
        />
      </Section>
    );
  }
  const { schema } = known;
  const ports = portsOf(schema);
  const bands = bandsOf(schema);
  return (
    <Section title="Device" description={note}>
      <StatusRow index={index} />
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
  addLabel: "Add hardware",
  newPage: <AddHardwarePage />,
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
    { header: "Status", cell: (i) => <Online index={i} /> },
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
