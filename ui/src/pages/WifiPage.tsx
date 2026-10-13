import { Badge, Group, Text } from "@mantine/core";
import { IconWifi, IconWifiOff } from "@tabler/icons-react";
import { ReactNode } from "react";
import { placeName, where } from "../../../src/intent/places";
import {
  SteeringLevel,
  steeringLabels,
  steeringSummary,
  takesPart,
} from "../../../src/intent/wifi";
import { Intent } from "../../../src/intent/schema";
import { Band } from "../../../src/intent/radios";
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
import { ItemIcon, ItemName, Section } from "../kit/layout";
import { bandLabels, shownName } from "../../../src/intent/labels";

const securityLabels: Record<string, string> = {
  wpa2: "WPA2",
  "wpa2-wpa3": "WPA2/WPA3",
  wpa3: "WPA3",
};

/** An SSID, crossed out while it is off. */
const SsidIcon = ({ index }: { index: number }) => {
  const on = useDraftValue(`wifi.networks.${index}.enabled`) !== false;
  return <ItemIcon icon={on ? IconWifi : IconWifiOff} color="blue" off={!on} />;
};

const wifiNetworks = defineList({
  name: "wifi.networks",
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
    roaming: { fast: true, assisted: true },
  }),
  itemTitle: (i) => <Value name={`wifi.networks.${i}.ssid`} fallback="New network" />,
  empty: "No Wi-Fi networks yet.",
  columns: [
    {
      header: "Name",
      cell: (i) => (
        <Group gap={8} wrap="nowrap">
          <ItemName icon={<SsidIcon index={i} />}>
            <Value name={`wifi.networks.${i}.ssid`} fallback="Unnamed" />
          </ItemName>
          <Value
            name={`wifi.networks.${i}.hidden`}
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
            name={`wifi.networks.${i}.security`}
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
            name={`wifi.networks.${i}.bands`}
            format={(bands) => (bands ? bands.map((b) => bandLabels[b]).join(", ") : "All enabled")}
          />
        </Text>
      ),
    },
  ],
  editor: (i) => (
    <>
      <Section>
        <TextField name={`wifi.networks.${i}.ssid`} />
        <SwitchField
          name={`wifi.networks.${i}.enabled`}
        />
        <ReferenceField
          name={`wifi.networks.${i}.network`}
          to="networks"
          valueKey="id"
          labelKey="name"
        />
      </Section>
      <Section title="Security">
        <SegmentedField
          name={`wifi.networks.${i}.security`}
          label="Mode"
          description="WPA2/WPA3 lets older devices join too."
          options={[
            { value: "wpa2", label: "WPA2" },
            { value: "wpa2-wpa3", label: "WPA2/WPA3" },
            { value: "wpa3", label: "WPA3" },
          ]}
        />
        <PasswordField name={`wifi.networks.${i}.password`} />
        <ExtraPasswordsField index={i} />
      </Section>
      <Section title="Broadcast">
        <BandsField index={i} />
        <SwitchField
          name={`wifi.networks.${i}.hidden`}
        />
        <SwitchField
          name={`wifi.networks.${i}.isolate_clients`}
        />
      </Section>
      <RoamingSection index={i}>
        <SwitchField
          name={`wifi.networks.${i}.roaming.fast`}
        />
      </RoamingSection>
    </>
  ),
});

/** The name of the network Wi-Fi `index` joins. */
const NetworkName = ({ index }: { index: number }) => {
  const id = useDraftValue(`wifi.networks.${index}.network`);
  const networks: { id: string; name: string }[] =
    useDraftValue("networks") ?? [];
  const network = networks.find((n) => n.id === id);
  return <>{network ? shownName(network.name) : "—"}</>;
};

export const WifiPage = ({ sub }: { sub: string }) => <ListPage list={wifiNetworks} sub={sub} />;

/**
 * Roaming on this SSID, saying what Steering (Wi-Fi › Roaming) does to it
 * now, from the same words the Roaming tab and the compiler use.
 */
const RoamingSection = ({ index, children }: { index: number; children: ReactNode }) => {
  const level: SteeringLevel = useDraftValue("wifi.roaming.steering") ?? "advise";
  const intent: Intent = useDraftValue();
  const ssid: Intent["wifi"]["networks"][number] | undefined = useDraftValue(`wifi.networks.${index}`);
  const assisted = level === "off" || (!!ssid && takesPart(intent, ssid));
  return (
    <Section
      title={placeName("roaming")}
      description={`Steering is ${steeringLabels[level]} (${where("roaming")}): ${
        assisted ? steeringSummary[level] : "this SSID's devices are left alone"
      }.`}
    >
      <SwitchField
        name={`wifi.networks.${index}.roaming.assisted`}
      />
      {children}
    </Section>
  );
};

/** Bands whose radios are off are greyed out, with why (choices.ts). */
const BandsField = ({ index }: { index: number }) => (
  <MultiSelectField
    name={`wifi.networks.${index}.bands`}
    description={`Empty: every band that is on.`}
    options={(Object.entries(bandLabels) as [Band, string][]).map(([value, label]) => ({
      value,
      label,
    }))}
    placeholder="All enabled"
    emptyIsUnset
  />
);

/** Only with WPA2, which has per-device passwords: not shown otherwise (choices.ts). */
const ExtraPasswordsField = ({ index }: { index: number }) => (
  <PasswordListField
    name={`wifi.networks.${index}.extra_passwords`}
    addLabel="Add password"
  />
);
