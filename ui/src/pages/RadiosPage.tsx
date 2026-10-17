// Wi-Fi › Radios: each band, on every access point. A read-only table, and
// a page per band (/wifi/radios/5g) with its settings explained.
import { Badge, Button, Text, ThemeIcon } from "@mantine/core";
import { useNavigate } from "react-router";
import { channelWidths } from "../../../src/intent/radios";
import { placeName, where } from "../../../src/intent/places";
import { Intent } from "../../../src/intent/schema";
import { Band } from "../../../src/intent/radios";
import { useDevices } from "../data/devices";
import { bandsOf } from "../facts";
import { useDraftValue, useIssues } from "../form/draft";
import {
  SegmentedField,
  SelectField,
  SwitchField,
  Value,
} from "../form/fields";
import { DataTable } from "../kit/DataTable";
import { Section, SettingRow, SettingsPage } from "../kit/layout";
import { IconAlertCircle } from "@tabler/icons-react";
import { bandLabels } from "../../../src/intent/labels";

const bands: { band: Band; label: string; description: string }[] = [
  {
    band: "2g",
    label: bandLabels["2g"],
    description: "Longest range, slowest; many smart-home devices need it.",
  },
  {
    band: "5g",
    label: bandLabels["5g"],
    description: "Fast, shorter range: most phones and laptops use it.",
  },
  {
    band: "6g",
    label: bandLabels["6g"],
    description:
      "Fastest, shortest range. Wi-Fi 6E and 7, WPA3 only.",
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
    key: keyof Intent["wifi"]["radios"][Band],
    format: (v?: string) => string | undefined,
  ) => (
    <Text size="sm" c="dimmed">
      <Value name={`wifi.radios.${band}.${key}`} format={(v) => format(v === undefined ? v : String(v))} />
    </Text>
  );
  return (
    <SettingsPage
      title="Radios"
      description={`Each band, on every access point.`}
    >
      <DataTable
        rowCount={bands.length}
        rowKey={(i) => bands[i].band}
        onRowClick={(i) => navigate(`/settings/wifi/radios/${bands[i].band}`)}
        rowMarker={(i) =>
          issues.some((issue) =>
            issue.path.startsWith(`wifi.radios.${bands[i].band}.`),
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
                name={`wifi.radios.${bands[i].band}.enabled`}
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

/** Which access points have this band, from their facts; nothing if none has been read. */
const useHaveBand = (label: string) => {
  const intent: Intent = useDraftValue();
  const facts = useDevices().data?.facts;
  const read = intent.hardware
    .filter((d) => d.role === "access-point")
    .flatMap((d) => (facts?.[d.name] ? [{ name: d.name, bands: bandsOf(facts[d.name]!.schema) }] : []));
  if (read.length === 0) return undefined;
  const have = read.filter((d) => d.bands.includes(label)).map((d) => d.name);
  return have.length ? `On ${have.join(", ")}.` : "None of your access points has it.";
};

const RadioPage = ({ band, label, description }: (typeof bands)[number]) => {
  const navigate = useNavigate();
  const { mesh } = (useDraftValue() as Intent).wifi;
  // The mesh's band is on its channel, on every node.
  const meshChannel = mesh.enabled && mesh.band === band ? mesh.channel : undefined;
  const haveBand = useHaveBand(label);
  const at = <K extends string>(key: K) => `wifi.radios.${band}.${key}` as const;
  return (
    <SettingsPage
      title={[
        { label: "Radios", onClick: () => navigate("/settings/wifi/radios") },
        { label },
      ]}
    >
      <Section description={haveBand ? `${description} ${haveBand}` : description}>
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
              ? "20 MHz is best where there are many networks."
              : "Wider is faster but has fewer clear channels. Auto picks the band's usual width."
          }
          options={widths}
        />
        <SegmentedField
          name={at("power")}
          label="Transmit power"
          description="Lower helps devices pick the nearest access point."
          options={powers}
        />
        <SegmentedField
          name={at("cell_density")}
          label="Cell density"
          description="Higher keeps slow, distant devices off the air."
          options={densities}
        />
        <SegmentedField
          name={at("airtime")}
          label="Airtime"
          description="Snappy calls and games, or the most data."
          options={airtimes}
        />
      </Section>
      <Section title="Channel">
        {band === "5g" && <SwitchField name={at("avoid_radar")} />}
        {meshChannel !== undefined ? (
          <SettingRow label="Channel" description={`Set by the mesh, on every access point (${where("mesh")}).`}>
            <Button variant="subtle" size="compact-sm" onClick={() => navigate("/settings/wifi/mesh")}>
              {meshChannel} · {placeName("mesh")}
            </Button>
          </SettingRow>
        ) : (
          <SettingRow label="Channel" description={`Picked automatically; pin one under ${where("hardware")}.`}>
            <Button variant="subtle" size="compact-sm" onClick={() => navigate("/settings/hardware")}>
              Auto · {placeName("hardware")}
            </Button>
          </SettingRow>
        )}
      </Section>
    </SettingsPage>
  );
};

export const RadiosPage = ({ sub }: { sub: string }) => {
  const radio = bands.find((b) => b.band === sub);
  return radio ? <RadioPage key={radio.band} {...radio} /> : <RadiosTable />;
};
