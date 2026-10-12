import { Badge, Group, Text } from "@mantine/core";
import { Band, Intent } from "../../../src/intent/schema";
import { useDraftValue } from "../form/draft";
import {
  MultiSelectField,
  PasswordField,
  PasswordListField,
  ReferenceField,
  SegmentedField,
  SwitchField,
  TextField,
  Value,
} from "../form/fields";
import { defineList, ListPage } from "../form/ListPage";
import { Section } from "../kit/layout";

const bandLabels: Record<string, string> = {
  "2g": "2.4 GHz",
  "5g": "5 GHz",
  "6g": "6 GHz",
};

const securityLabels: Record<string, string> = {
  wpa2: "WPA2",
  "wpa2-wpa3": "WPA2/WPA3",
  wpa3: "WPA3",
};

const wifiNetworks = defineList({
  name: "wifi",
  title: "SSIDs",
  description:
    "Each SSID is broadcast by every access point, on its bands, with seamless roaming between them.",
  addLabel: "Add network",
  // Joins the main network unless told otherwise.
  newItem: (_, intent) => ({
    ssid: "",
    enabled: true,
    // New networks: WPA3 where devices can, WPA2 for those that cannot.
    security: "wpa2-wpa3" as const,
    password: "",
    network: intent.networks.find((n) => n.vlan === undefined)?.id ?? "",
    hidden: false,
    isolate_clients: false,
    fast_roaming: true,
    roaming_assistance: true,
  }),
  itemTitle: (i) => <Value name={`wifi.${i}.ssid`} fallback="New network" />,
  empty: "No Wi-Fi networks yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <Group gap={8} wrap="nowrap">
          <Text size="sm" fw={500}>
            <Value name={`wifi.${i}.ssid`} fallback="Unnamed" />
          </Text>
          <Value
            name={`wifi.${i}.enabled`}
            format={(on) =>
              on === false && (
                <Badge variant="light" color="gray">
                  Off
                </Badge>
              )
            }
          />
          <Value
            name={`wifi.${i}.hidden`}
            format={(hidden) =>
              hidden && (
                <Badge variant="light" color="gray">
                  Hidden
                </Badge>
              )
            }
          />
        </Group>
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
      header: "Security",
      cell: (i) => (
        <Text size="sm" c="dimmed">
          <Value
            name={`wifi.${i}.security`}
            format={(mode) => securityLabels[mode ?? "wpa2"]}
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
        <SwitchField
          name={`wifi.${i}.enabled`}
          label="Enabled"
          description="Off: kept here, but no access point broadcasts it."
        />
        <ReferenceField
          name={`wifi.${i}.network`}
          label="Network"
          description="Devices that join this Wi-Fi land on that network."
          to="networks"
          valueKey="id"
          labelKey="name"
        />
      </Section>
      <Section title="Security">
        <SegmentedField
          name={`wifi.${i}.security`}
          label="Mode"
          description="WPA3 is stronger. WPA2/WPA3 lets older devices join too. 6 GHz is always WPA3."
          options={[
            { value: "wpa2", label: "WPA2" },
            { value: "wpa2-wpa3", label: "WPA2/WPA3" },
            { value: "wpa3", label: "WPA3" },
          ]}
        />
        <PasswordField name={`wifi.${i}.password`} label="Password" />
        <ExtraPasswordsField index={i} />
      </Section>
      <Section title="Broadcast">
        <BandsField index={i} />
        <SwitchField
          name={`wifi.${i}.hidden`}
          label="Hidden"
          description="Its name is not announced: devices must be told it. It does not make the network more secure."
        />
        <SwitchField
          name={`wifi.${i}.isolate_clients`}
          label="Isolate clients"
          description="Devices on it, on the same access point and band, cannot reach each other."
        />
      </Section>
      <Section
        title="Roaming"
        description="With more than one access point. They share what they see, but never push a device anywhere: each device decides when to move."
      >
        <SwitchField
          name={`wifi.${i}.roaming_assistance`}
          label="Roaming assistance"
          description="Access points tell devices which neighbours are near (802.11k/v), so devices find a better one sooner."
        />
        <SwitchField
          name={`wifi.${i}.fast_roaming`}
          label="Fast roaming"
          description="Devices move between access points without a pause (802.11r). Turn off if an older device keeps dropping."
        />
      </Section>
    </>
  ),
});

/** The name of the network Wi-Fi `index` joins. */
const NetworkName = ({ index }: { index: number }) => {
  const id = useDraftValue(`wifi.${index}.network`);
  const networks: { id: string; name: string }[] =
    useDraftValue("networks") ?? [];
  return <>{networks.find((n) => n.id === id)?.name ?? "—"}</>;
};

export const WifiPage = ({ sub }: { sub: string }) => <ListPage list={wifiNetworks} sub={sub} />;

/** Bands whose radios are off are greyed out, with why (choices.ts). */
const BandsField = ({ index }: { index: number }) => (
  <MultiSelectField
    name={`wifi.${index}.bands`}
    label="Bands"
    description="Empty: every band that is on. A band that is off can be turned on under Wi-Fi › Radios."
    options={(Object.entries(bandLabels) as [Band, string][]).map(([value, label]) => ({
      value,
      label,
    }))}
    placeholder="All enabled"
    emptyIsUnset
  />
);

/** Only with WPA2, which has per-device passwords: greyed out otherwise, with why (choices.ts). */
const ExtraPasswordsField = ({ index }: { index: number }) => (
  <PasswordListField
    name={`wifi.${index}.extra_passwords`}
    label="More passwords"
    description="Each works on its own, e.g. one per person."
    addLabel="Add password"
  />
);
