import { Badge, Group, Text } from "@mantine/core";
import { ReactNode } from "react";
import { placeName, where } from "../../../src/intent/places";
import {
  SteeringLevel,
  steeringLabels,
  steeringSummary,
  takesPart,
} from "../../../src/intent/roaming";
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
    "Broadcast by every access point.",
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
          description="WPA2/WPA3 lets older devices join too."
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
          description="Not announced; devices must be told the name."
        />
        <SwitchField
          name={`wifi.${i}.isolate_clients`}
          label="Isolate clients"
          description="Its devices cannot reach each other."
        />
      </Section>
      <RoamingSection index={i}>
        <SwitchField
          name={`wifi.${i}.fast_roaming`}
          label="Fast roaming"
          description="Seamless handover between access points."
        />
      </RoamingSection>
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

/**
 * Roaming on this SSID, saying what Steering (Wi-Fi › Roaming) does to it
 * now, from the same words the Roaming tab and the compiler use.
 */
const RoamingSection = ({ index, children }: { index: number; children: ReactNode }) => {
  const level: SteeringLevel = useDraftValue("roaming.steering") ?? "advise";
  const intent: Intent = useDraftValue();
  const ssid: Intent["wifi"][number] | undefined = useDraftValue(`wifi.${index}`);
  const assisted = level === "off" || (!!ssid && takesPart(intent, ssid));
  return (
    <Section
      title={placeName("roaming")}
      description={`Steering is ${steeringLabels[level]} (${where("roaming")}): ${
        assisted ? steeringSummary[level] : "this SSID's devices are left alone"
      }.`}
    >
      <SwitchField
        name={`wifi.${index}.roaming_assistance`}
        label="Roaming assistance"
        description="Neighbour lists help devices find a better access point."
      />
      {children}
    </Section>
  );
};

/** Bands whose radios are off are greyed out, with why (choices.ts). */
const BandsField = ({ index }: { index: number }) => (
  <MultiSelectField
    name={`wifi.${index}.bands`}
    label="Bands"
    description={`Empty: every band that is on.`}
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
