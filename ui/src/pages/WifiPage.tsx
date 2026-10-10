import { Text } from "@mantine/core";
import { PasswordField, PasswordListField, TextField, Value } from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";

const wifiNetworks = defineList({
  name: "wifi",
  title: "Wi-Fi",
  description:
    "Every network is broadcast by every access point, on every band, with seamless roaming between them.",
  addLabel: "Add network",
  newItem: () => ({ ssid: "", password: "" }),
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
      cell: () => (
        <Text size="sm" c="dimmed">
          2.4 and 5 GHz
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <TextField name={`wifi.${i}.ssid`} label="Name" />
      <PasswordField name={`wifi.${i}.password`} label="Password" />
      <PasswordListField
        name={`wifi.${i}.extra_passwords`}
        label="More passwords"
        description="Each works on its own, e.g. one per person."
        addLabel="Add password"
      />
    </>
  ),
});

export const WifiPage = () => <ListPage list={wifiNetworks} />;
