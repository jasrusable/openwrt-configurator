// Wi-Fi › Roaming: how firmly access points move devices to a better access
// point or band (usteer). Its OpenWrt details are in each setting's ⓘ.
import { Text } from "@mantine/core";
import { placeName, where } from "../../../src/intent/places";
import {
  SteeringLevel,
  steeredSsids,
  steeringLabels,
  steeringLevels,
  steeringSummary,
} from "../../../src/intent/roaming";
import { Intent } from "../../../src/intent/schema";
import { useDraftValue } from "../form/draft";
import { SegmentedField, SwitchField } from "../form/fields";
import { Section, SettingRow, SettingsPage } from "../kit/layout";

// The levels and their names are the compiler's (roaming.ts).
const steering = steeringLevels.map((value) => ({ value, label: steeringLabels[value] }));

/** The SSIDs it applies to: those with roaming assistance on. */
const AppliesTo = () => {
  const intent: Intent = useDraftValue();
  const off = intent.roaming?.steering === "off";
  // The compiler's own list (usteer's ssid_list).
  const names = off ? [] : steeredSsids(intent).map((w) => w.ssid || "Unnamed");
  return (
    <SettingRow
      label="Applies to"
      description={`SSIDs with roaming assistance on (${where("ssids")}).`}
    >
      <Text size="sm" c="dimmed" ta="right">
        {off ? `None: steering is ${steeringLabels.off}` : names.length ? names.join(", ") : "No SSIDs"}
      </Text>
    </SettingRow>
  );
};

/** Says what the chosen level does, in the words the SSIDs' pages use too. */
const SteeringField = () => {
  const level: SteeringLevel = useDraftValue("roaming.steering") ?? "advise";
  const summary = steeringSummary[level];
  return (
    <SegmentedField
      name="roaming.steering"
      label="Steering"
      description={summary[0].toUpperCase() + summary.slice(1) + "."}
      options={steering}
    />
  );
};

export const RoamingPage = () => (
  <SettingsPage
    title={placeName("roaming")}
    description="Help devices that hold on to a weak signal."
  >
    <Section>
      <SteeringField />
      <SwitchField
        name="roaming.prefer_5g"
        label="Prefer 5 GHz"
        description="Moves strong dual-band devices off 2.4 GHz."
      />
      <AppliesTo />
    </Section>
  </SettingsPage>
);
