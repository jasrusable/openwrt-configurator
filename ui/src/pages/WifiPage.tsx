import { Text } from "@mantine/core";
import { useWatch } from "react-hook-form";
import {
  MultiSelectField,
  PasswordField,
  PasswordListField,
  ReferenceField,
  SwitchField,
  TextField,
  Value,
} from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";
import { Section } from "../kit/layout";

const bandLabels: Record<string, string> = { "2g": "2.4 GHz", "5g": "5 GHz", "6g": "6 GHz" };

const wifiNetworks = defineList({
  name: "wifi",
  title: "SSIDs",
  description:
    "Each SSID is broadcast by every access point, on its bands, with seamless roaming between them.",
  addLabel: "Add network",
  // Joins the main network unless told otherwise.
  newItem: (_, intent) => ({
    ssid: "",
    password: "",
    network: intent.networks.find((n) => n.vlan === undefined)?.id ?? "",
    isolate_clients: false,
  }),
  itemTitle: (i) => <Value name={`wifi.${i}.ssid`} fallback="New network" />,
  empty: "No Wi-Fi networks yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <Text size="sm" fw={500}>
          <Value name={`wifi.${i}.ssid`} fallback="Unnamed" />
        </Text>
      ),
    },
    {
      header: "Network",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <NetworkName index={i} />
        </Text>
      ),
    },
    {
      header: "Passwords",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value
            name={`wifi.${i}.extra_passwords`}
            format={(extra?: string[]) => `${1 + (extra?.length ?? 0)}`}
          />
        </Text>
      ),
    },
    {
      header: "Bands",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value
            name={`wifi.${i}.bands`}
            format={(bands?: string[]) =>
              bands ? bands.map((b) => bandLabels[b]).join(", ") : "All enabled"
            }
          />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`wifi.${i}.ssid`} label="Name" />
        <ReferenceField
          name={`wifi.${i}.network`}
          label="Network"
          description="Devices that join this Wi-Fi land on that network."
          to="networks"
          valueKey="id"
          labelKey="name"
        />
      </Section>
      <Section
        title="Security"
        description="WPA2. Devices join with any of these passwords."
      >
        <PasswordField name={`wifi.${i}.password`} label="Password" />
        <PasswordListField
          name={`wifi.${i}.extra_passwords`}
          label="More passwords"
          description="Each works on its own, e.g. one per person."
          addLabel="Add password"
        />
      </Section>
      <Section title="Broadcast">
        <MultiSelectField
          name={`wifi.${i}.bands`}
          label="Bands"
          description="Empty: every band that is on (Wi-Fi › Radios)."
          options={Object.entries(bandLabels).map(([value, label]) => ({ value, label }))}
          placeholder="All enabled"
          emptyIsUnset
        />
        <SwitchField
          name={`wifi.${i}.isolate_clients`}
          label="Isolate clients"
          description="Devices on it, on the same access point and band, cannot reach each other."
        />
      </Section>
    </>
  ),
});

/** The name of the network Wi-Fi `index` joins. */
const NetworkName = ({ index }: { index: number }) => {
  const id = useWatch({ name: `wifi.${index}.network` });
  const networks: { id: string; name: string }[] =
    useWatch({ name: "networks" }) ?? [];
  return <>{networks.find((n) => n.id === id)?.name ?? "—"}</>;
};

export const WifiPage = () => <ListPage list={wifiNetworks} />;
