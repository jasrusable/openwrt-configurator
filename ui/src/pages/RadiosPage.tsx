// Wi-Fi › Radios: each band, on every access point. A read-only table, and
// a page per band (/wifi/radios/5g) with its settings explained.
import { Badge, Button, Text } from "@mantine/core";
import { useNavigate } from "react-router";
import { channelWidths } from "../../../src/intent/choices";
import { Band } from "../../../src/intent/schema";
import { useIssues } from "../form/draft";
import {
  SegmentedField,
  SelectField,
  SwitchField,
  Value,
} from "../form/fields";
import { DataTable } from "../kit/DataTable";
import { Section, SettingRow, SettingsPage } from "../kit/layout";
import { ThemeIcon } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

const bands: { band: Band; label: string; description: string }[] = [
  {
    band: "2g",
    label: "2.4 GHz",
    description: "Longest range, slowest; many smart-home devices need it.",
  },
  {
    band: "5g",
    label: "5 GHz",
    description: "Fast, shorter range: most phones and laptops use it.",
  },
  {
    band: "6g",
    label: "6 GHz",
    description:
      "Fastest, shortest range (Wi-Fi 6E and 7). Only on access points that have it, and always WPA3.",
  },
];

// What a band may not use (80 MHz on 2.4 GHz) is greyed out by the rules (choices.ts).
const widths = channelWidths.map((w) => ({
  value: w,
  label: w === "auto" ? "Auto" : `${w} MHz`,
}));

const powers = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

const densities = [
  { value: "off", label: "Off" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "very_high", label: "Very high" },
];

const airtimes = [
  { value: "latency", label: "Low latency" },
  { value: "balanced", label: "Balanced" },
  { value: "throughput", label: "Throughput" },
];

const labelOf =
  (options: { value: string; label: string }[]) => (value?: string) =>
    options.find((o) => o.value === value)?.label ?? value;

const RadiosTable = () => {
  const navigate = useNavigate();
  const issues = useIssues();
  const cell = (
    band: Band,
    key: string,
    format: (v: any) => string | undefined,
  ) => (
    <Text size="sm" c="dimmed">
      <Value name={`radios.${band}.${key}` as never} format={format} />
    </Text>
  );
  return (
    <SettingsPage
      title="Radios"
      description="Each band's radios, on every access point. Channels are picked automatically; to pin one, open the access point under Hardware."
    >
      <DataTable
        rowCount={bands.length}
        rowKey={(i) => bands[i].band}
        onRowClick={(i) => navigate(`/wifi/radios/${bands[i].band}`)}
        rowMarker={(i) =>
          issues.some((issue) =>
            issue.path.startsWith(`radios.${bands[i].band}.`),
          ) && (
            <ThemeIcon size={18} radius="xl" color="red" variant="light">
              <IconAlertCircle size={14} />
            </ThemeIcon>
          )
        }
        empty={null}
        columns={[
          {
            header: "Band",
            cell: (i) => (
              <Text size="sm" fw={500}>
                {bands[i].label}
              </Text>
            ),
          },
          {
            header: "Status",
            cell: (i) => (
              <Value
                name={`radios.${bands[i].band}.enabled`}
                format={(on) => (
                  <Badge variant="light" color={on ? "green" : "gray"}>
                    {on ? "On" : "Off"}
                  </Badge>
                )}
              />
            ),
          },
          {
            header: "Channel width",
            cell: (i) =>
              cell(bands[i].band, "width", labelOf(widths)),
          },
          {
            header: "Transmit power",
            cell: (i) => cell(bands[i].band, "power", labelOf(powers)),
          },
          {
            header: "Cell density",
            cell: (i) =>
              cell(bands[i].band, "cell_density", labelOf(densities)),
          },
          {
            header: "Airtime",
            cell: (i) => cell(bands[i].band, "airtime", labelOf(airtimes)),
          },
        ]}
      />
    </SettingsPage>
  );
};

const RadioPage = ({ band, label, description }: (typeof bands)[number]) => {
  const navigate = useNavigate();
  const at = (key: string) => `radios.${band}.${key}` as never;
  return (
    <SettingsPage
      title={[
        { label: "Radios", onClick: () => navigate("/wifi/radios") },
        { label },
      ]}
    >
      <Section description={description}>
        <SwitchField
          name={at("enabled")}
          label="Enabled"
          description="Off: no access point uses this band."
        />
      </Section>
      <Section title="Signal">
        <SelectField
          name={at("width")}
          label="Channel width"
          description={
            band === "2g"
              ? "Wider is faster but crowds neighbours; 2.4 GHz is at most 40 MHz, and 20 MHz is best where there are many networks."
              : "Wider is faster but has fewer clear channels. Auto picks the band's usual width."
          }
          options={widths}
        />
        <SegmentedField
          name={at("power")}
          label="Transmit power"
          description="Lower power keeps devices on the nearest access point, which helps with several of them. Auto is the most your country allows."
          options={powers}
        />
        <SegmentedField
          name={at("cell_density")}
          label="Cell density"
          description="Higher keeps slow, far-away devices from holding the air: faster for everyone, a little less range. Off lets very old devices connect."
          options={densities}
        />
        <SegmentedField
          name={at("airtime")}
          label="Airtime"
          description="What this band's Wi-Fi favours, for every SSID on it. Low latency keeps calls and games snappy while something downloads; throughput moves the most data. Balanced is OpenWrt's own."
          options={airtimes}
        />
      </Section>
      <Section title="Channel">
        <SettingRow
          label="Channel"
          description="Each access point picks the clearest channel when it starts. To pin one, open the access point under Hardware."
        >
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={() => navigate("/hardware")}
          >
            Auto · Hardware
          </Button>
        </SettingRow>
      </Section>
    </SettingsPage>
  );
};

export const RadiosPage = ({ sub }: { sub: string }) => {
  const radio = bands.find((b) => b.band === sub);
  return radio ? <RadioPage {...radio} /> : <RadiosTable />;
};
