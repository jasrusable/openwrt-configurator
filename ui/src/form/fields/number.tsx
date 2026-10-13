// Number controls bound to a setting: a number, and a duration (a number and a unit).
import { Group, NumberInput, Select } from "@mantine/core";
import { useState } from "react";
import { control, RowProps, FieldRow, asNumber, useField } from "./binding";

export const NumberField = ({
  unit,
  min,
  max,
  integer,
  required,
  ...row
}: RowProps & {
  unit?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  /** Emptied, it is empty only while typing: unset would mean something else (a VLAN-less network is the main one). */
  required?: boolean;
}) => {
  const field = useField(row.name);
  const [typing, setTyping] = useState<string | number>();
  return (
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <NumberInput
        disabled={!!field.unavailable}
        value={typing ?? asNumber(field.value)}
        onChange={(value) => {
          setTyping(value);
          // Half-typed ("-", "1."): not a number yet, so the draft keeps what it had.
          if (value === "") {
            if (!required) field.onChange(undefined);
          } else if (Number.isFinite(Number(value))) field.onChange(Number(value));
        }}
        onBlur={() => setTyping(undefined)}
        min={min}
        max={max}
        allowDecimal={!integer}
        allowNegative={min === undefined || min < 0}
        rightSection={unit}
        rightSectionWidth={unit ? 56 : undefined}
        error={!!field.error}
        style={control.narrow}
      />
    </FieldRow>
  );
};

/** A duration like "12h": a whole number and a unit, each unit with its least (a lease is 2 minutes at least). */
const units = [
  { value: "m", label: "minutes", min: 2 },
  { value: "h", label: "hours", min: 1 },
  { value: "d", label: "days", min: 1 },
];

export const DurationField = (row: RowProps) => {
  const field = useField(row.name);
  // What is typed, while it is typed: cleared then retyped is "24", not "124".
  const [typing, setTyping] = useState<string | number>();
  const match = /^(\d+)([mhd])$/.exec(String(field.value ?? ""));
  const amount = match ? Number(match[1]) : 12;
  const unit = units.find((u) => u.value === (match ? match[2] : "h"))!;
  return (
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <Group gap={6} wrap="nowrap">
        <NumberInput
          disabled={!!field.unavailable}
          value={typing ?? amount}
          min={unit.min}
          allowDecimal={false}
          allowNegative={false}
          onChange={(n) => {
            setTyping(n);
            if (n !== "") field.onChange(`${Number(n)}${unit.value}`);
          }}
          onBlur={() => setTyping(undefined)}
          w={90}
        />
        <Select
          disabled={!!field.unavailable}
          data={units}
          value={unit.value}
          allowDeselect={false}
          onChange={(next) => {
            const to = units.find((u) => u.value === next)!;
            field.onChange(`${Math.max(amount, to.min)}${to.value}`);
          }}
          w={110}
        />
      </Group>
    </FieldRow>
  );
};
