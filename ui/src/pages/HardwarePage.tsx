import { Anchor, Group, Text } from "@mantine/core";
import { Link } from "react-router";
import { placeName } from "../../../src/intent/places";
import { FixStateBadge, useFixes } from "../fixes";
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
import { useDevices, useFreshDevices } from "../data/devices";
import { Intent } from "../../../src/intent/schema";
import { rescueAddress, rescueAfterMinutes, rescueSsid } from "../../../src/intent/mesh";
import { AddHardwarePage } from "./AddHardwarePage";
import { useNetworkStatus } from "../data/status";
import { ago, bandsOf, duration, meshAbility, modelOf, portsOf } from "../facts";
import { ItemIcon, ItemName, Section, SettingRow, StatusDot } from "../kit/layout";
import { bandLabels } from "../../../src/intent/labels";
import { channelsOf } from "../../../src/intent/radios";

// Unset is automatic, so it is offered by `emptyLabel`, not listed here.
const channels = (numbers: number[]) =>
  numbers.map((n) => ({ value: n, label: `Channel ${n}` }));
const channels2g = channels([...channelsOf["2g"]]);
const channels5g = channels([...channelsOf["5g"]]);

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
  const status = useNetworkStatus();
  const now = status.data?.devices.find((d) => d.name === name);
  const health = now?.health;
  return !now
    ? status.error && !status.isFetching
      ? { color: "gray" as const, label: "Not read", detail: (status.error as Error).message }
      : { color: "gray" as const, label: "Checking…" }
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
/**
 * The fixes on this device (src/intent/patches): those on, turned off, or
 * not known until its facts are read; the rest (not for it, not needed) are
 * on the Fixes page.
 */
const DeviceFixes = ({ index }: { index: number }) => {
  const name = useDraftValue(`hardware.${index}.name`);
  const fixes = useFixes()
    .map((fix) => ({ fix, on: fix.devices.find((d) => d.device === name) }))
    .filter(({ on }) => on && ["active", "off", "unknown", "fixed"].includes(on.state));
  if (!fixes.length) return null;
  return (
    <Section title="Fixes on this device" description={`What this app layers over OpenWrt here; every fix is under ${placeName("fixes")}.`}>
      {fixes.map(({ fix, on }) => (
        <SettingRow key={fix.id} label={<Anchor component={Link} to="/fixes" size="sm">{fix.title}</Anchor>} description={on!.why}>
          <FixStateBadge state={on!.state} why={on!.why} />
        </SettingRow>
      ))}
    </Section>
  );
};

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

/**
 * How an access point reaches the network, once the mesh is on: a cable, or
 * the mesh. "Mesh" is greyed out where its radio in the mesh's band cannot
 * (from its facts: a warning, never a refusal; the schema's rules refuse).
 */
const UplinkSection = ({ index }: { index: number }) => {
  const intent: Intent = useDraftValue();
  const facts = useDevices().data?.facts;
  const device = intent.hardware[index];
  if (!intent.wifi.mesh.enabled || device?.role !== "access-point") return null;
  const cannot = {
    unknown: undefined,
    can: undefined,
    "no-radio": `It has no ${bandLabels[intent.wifi.mesh.band]} radio.`,
    cannot: "Its radio cannot mesh.",
  }[meshAbility(facts?.[device.name]?.schema, intent.wifi.mesh.band)];
  return (
    <Section>
      <SegmentedField
        name={`hardware.${index}.uplink`}
        options={[
          { value: "cable", label: "Cable" },
          { value: "mesh", label: "Mesh", disabled: !!cannot && device.uplink !== "mesh", reason: cannot },
        ]}
      />
      {device.uplink === "mesh" && (
        <SettingRow
          label="If it loses the mesh"
          description={`After ${rescueAfterMinutes} minutes it shows “${rescueSsid(device.name)}” (the mesh key): join it, then ssh root@${rescueAddress(device.name)}.`}
        />
      )}
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
                ? `${channel(device.radios?.["2g"]?.channel)} · ${channel(
                    device.radios?.["5g"]?.channel,
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
        />
        <SegmentedField
          name={`hardware.${i}.role`}
          options={roles}
        />
        <TextField
          name={`hardware.${i}.location`}
          placeholder="Living room"
        />
      </Section>
      <UplinkSection index={i} />
      <When name={`hardware.${i}.role`} is="access-point">
        <Section
          title="Wi-Fi"
          description="Pin one only to avoid a crowded channel."
        >
          <SelectField
            name={`hardware.${i}.radios.2g.channel`}
            label={`${bandLabels["2g"]} channel`}
            options={channels2g}
            emptyLabel="Automatic"
          />
          <SelectField
            name={`hardware.${i}.radios.5g.channel`}
            label={`${bandLabels["5g"]} channel`}
            options={channels5g}
            emptyLabel="Automatic"
          />
        </Section>
      </When>
      <DeviceFacts index={i} />
      <DeviceFixes index={i} />
    </>
  ),
});

export const HardwarePage = () => <ListPage list={hardware} />;
