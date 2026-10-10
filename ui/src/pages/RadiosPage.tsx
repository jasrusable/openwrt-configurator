import { Band } from "../../../src/intent/schema";
import { SegmentedField, SelectField, SwitchField } from "../form/fields";
import { SettingsPage } from "../kit/layout";
import { SettingsTable } from "../kit/SettingsTable";

const widths = (band: Band) => [
  { value: "auto", label: "Auto" },
  ...(band === "2g" ? ["20", "40"] : ["20", "40", "80", "160"]).map((w) => ({
    value: w,
    label: `${w} MHz`,
  })),
];

export const RadiosPage = () => (
  <SettingsPage
    title="Radios"
    description="Each band's radios, on every access point. 6 GHz only works on access points that have it, and uses WPA3. Channels are pinned per access point, under Devices."
  >
    <SettingsTable<Band>
      rows={[
        {
          key: "2g",
          label: "2.4 GHz",
          description: "Longest range; many smart-home devices need it.",
        },
        { key: "5g", label: "5 GHz", description: "Faster, shorter range." },
        {
          key: "6g",
          label: "6 GHz",
          description: "Fastest, shortest range (Wi-Fi 6E).",
        },
      ]}
      columns={[
        {
          header: "Enabled",
          cell: (band) => (
            <SwitchField
              inline
              name={`radios.${band}.enabled`}
              label="Enabled"
            />
          ),
        },
        {
          header: "Transmit power",
          cell: (band) => (
            <SegmentedField
              inline
              name={`radios.${band}.power`}
              label="Transmit power"
              options={[
                { value: "auto", label: "Auto" },
                { value: "low", label: "Low" },
                { value: "medium", label: "Med" },
                { value: "high", label: "High" },
              ]}
            />
          ),
        },
        {
          header: "Channel width",
          cell: (band) => (
            <SelectField
              inline
              name={`radios.${band}.width`}
              label="Channel width"
              options={widths(band)}
            />
          ),
        },
        {
          header: "Cell density",
          cell: (band) => (
            <SegmentedField
              inline
              name={`radios.${band}.cell_density`}
              label="Cell density"
              options={[
                { value: "off", label: "Off" },
                { value: "normal", label: "Normal" },
                { value: "high", label: "High" },
                { value: "very_high", label: "Very high" },
              ]}
            />
          ),
        },
      ]}
    />
  </SettingsPage>
);
