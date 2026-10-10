import { Band } from "../../../src/intent/schema";
import { SegmentedField, SelectField, SwitchField } from "../form/fields";
import { Section, SettingsPage } from "../kit/layout";

const widths = (band: Band) => [
  { value: "auto", label: "Automatic" },
  ...(band === "2g" ? ["20", "40"] : ["20", "40", "80", "160"]).map((w) => ({
    value: w,
    label: `${w} MHz`,
  })),
];

const bandInfo: { band: Band; title: string; description: string }[] = [
  {
    band: "2g",
    title: "2.4 GHz",
    description: "The longest range, through walls; the most crowded. Many smart-home devices need it.",
  },
  { band: "5g", title: "5 GHz", description: "Faster, shorter range: what most devices use." },
  {
    band: "6g",
    title: "6 GHz",
    description:
      "The fastest, shortest range, on access points that have it (Wi-Fi 6E). SSIDs use WPA3 there.",
  },
];

export const RadiosPage = () => (
  <SettingsPage
    title="Radios"
    description="Each band's radios, on every access point. Channels are pinned per access point, under Devices."
  >
    {bandInfo.map(({ band, title, description }) => (
      <Section key={band} title={title} description={description}>
        <SwitchField name={`radios.${band}.enabled`} label="Enabled" />
        <SegmentedField
          name={`radios.${band}.power`}
          label="Transmit power"
          description="Lower it to keep clients on a nearer access point."
          options={[
            { value: "auto", label: "Auto" },
            { value: "low", label: "Low" },
            { value: "medium", label: "Medium" },
            { value: "high", label: "High" },
          ]}
        />
        <SelectField
          name={`radios.${band}.width`}
          label="Channel width"
          description="Wider is faster, but more prone to interference."
          options={widths(band)}
        />
        <SegmentedField
          name={`radios.${band}.cell_density`}
          label="Cell density"
          description="Higher keeps clients on fast rates near each access point, at the cost of range."
          options={[
            { value: "off", label: "Off" },
            { value: "normal", label: "Normal" },
            { value: "high", label: "High" },
            { value: "very_high", label: "Very high" },
          ]}
        />
      </Section>
    ))}
  </SettingsPage>
);
