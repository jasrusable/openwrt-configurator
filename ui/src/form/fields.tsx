// Settings bound to the intent by name: <TextField name="site.name" />. Each
// renders a SettingRow with its control and its validation error, so a page
// only says which settings it shows, in what order, and how they are labelled.
import {
  Button,
  Group,
  MultiSelect,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TagsInput,
  TextInput,
} from "@mantine/core";
import { ReactNode } from "react";
import { useController, useWatch } from "react-hook-form";
import { SettingRow } from "../kit/layout";
import { IntentField, useIntentForm } from "./IntentForm";

/** Control widths: fixed in a wide row, shrinking to fit a narrow one. */
const control = {
  wide: { width: 260, maxWidth: "100%" },
  narrow: { width: 160, maxWidth: "100%" },
};

type RowProps = {
  name: IntentField;
  label: ReactNode;
  description?: ReactNode;
};

const useField = (name: IntentField) => {
  const { field, fieldState } = useController({ name });
  return {
    value: field.value as any,
    onChange: field.onChange,
    onBlur: field.onBlur,
    error: fieldState.error?.message,
  };
};

export const TextField = ({
  placeholder,
  ...row
}: RowProps & { placeholder?: string }) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <TextInput
        value={field.value ?? ""}
        onChange={(e) => field.onChange(e.currentTarget.value)}
        onBlur={field.onBlur}
        placeholder={placeholder}
        error={!!field.error}
        spellCheck={false}
        style={control.wide}
      />
    </SettingRow>
  );
};

export const PasswordField = (row: RowProps) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <PasswordInput
        value={field.value ?? ""}
        onChange={(e) => field.onChange(e.currentTarget.value)}
        onBlur={field.onBlur}
        error={!!field.error}
        style={control.wide}
      />
    </SettingRow>
  );
};

export const NumberField = ({
  unit,
  min,
  max,
  ...row
}: RowProps & { unit?: string; min?: number; max?: number }) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <NumberInput
        value={field.value ?? ""}
        onChange={(value) => field.onChange(value === "" ? undefined : Number(value))}
        onBlur={field.onBlur}
        min={min}
        max={max}
        rightSection={unit}
        rightSectionWidth={unit ? 56 : undefined}
        error={!!field.error}
        style={control.narrow}
      />
    </SettingRow>
  );
};

export const SwitchField = (row: RowProps) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <Switch
        checked={!!field.value}
        onChange={(e) => field.onChange(e.currentTarget.checked)}
        size="md"
      />
    </SettingRow>
  );
};

export type Option<T> = { value: T; label: string };

/**
 * A choice from a list. Values may be strings or numbers; with `emptyLabel`
 * there is also a choice that leaves the setting unset.
 */
export const SelectField = <T extends string | number>({
  options,
  emptyLabel,
  searchable,
  ...row
}: RowProps & {
  options: Option<T>[];
  emptyLabel?: string;
  searchable?: boolean;
}) => {
  const field = useField(row.name);
  const empty = "\u0000";
  const data = [
    ...(emptyLabel ? [{ value: empty, label: emptyLabel }] : []),
    ...options.map((option) => ({ value: String(option.value), label: option.label })),
  ];
  return (
    <SettingRow {...row} error={field.error}>
      <Select
        data={data}
        value={field.value === undefined ? (emptyLabel ? empty : null) : String(field.value)}
        onChange={(value) =>
          field.onChange(
            value === null || value === empty
              ? undefined
              : options.find((option) => String(option.value) === value)?.value
          )
        }
        searchable={searchable}
        allowDeselect={false}
        error={!!field.error}
        style={control.wide}
      />
    </SettingRow>
  );
};

export const SegmentedField = <T extends string>({
  options,
  ...row
}: RowProps & { options: Option<T>[] }) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <SegmentedControl
        data={options}
        value={field.value}
        onChange={field.onChange}
      />
    </SettingRow>
  );
};

/**
 * Which variant of a tagged union an object is, e.g. a DHCP or a PPPoE
 * connection. Picking one replaces the whole object with that variant's
 * starting value, so fields of the old variant do not linger.
 */
export const VariantField = <T extends { type: string }>({
  variants,
  ...row
}: RowProps & { variants: (Option<T["type"]> & { initial: T })[] }) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <SegmentedControl
        data={variants.map(({ value, label }) => ({ value, label }))}
        value={field.value?.type}
        onChange={(type) =>
          field.onChange(variants.find((variant) => variant.value === type)!.initial)
        }
      />
    </SettingRow>
  );
};

/**
 * A switch for an optional group of settings: on, the setting is `initial`
 * and its fields (children) show; off, it is left out of the file.
 */
export const OptionalField = ({
  initial,
  children,
  ...row
}: RowProps & { initial: unknown; children: ReactNode }) => {
  const field = useField(row.name);
  const on = field.value !== undefined;
  return (
    <>
      <SettingRow {...row} error={field.error}>
        <Switch
          checked={on}
          onChange={(e) => field.onChange(e.currentTarget.checked ? initial : undefined)}
          size="md"
        />
      </SettingRow>
      {on && children}
    </>
  );
};

/** A list of strings, edited one row each, e.g. extra Wi-Fi passwords. */
export const PasswordListField = ({
  addLabel,
  ...row
}: RowProps & { addLabel: string }) => {
  const field = useField(row.name);
  const items: string[] = field.value ?? [];
  const set = (next: string[]) => field.onChange(next.length ? next : undefined);
  return (
    <SettingRow {...row} error={field.error}>
      <Stack gap={6} style={control.wide}>
        {items.map((item, i) => (
          <PasswordInput
            key={i}
            value={item}
            onChange={(e) =>
              set(items.map((old, j) => (j === i ? e.currentTarget.value : old)))
            }
            rightSectionWidth={64}
            rightSection={
              <Button
                variant="subtle"
                color="red"
                size="compact-xs"
                onClick={() => set(items.filter((_, j) => j !== i))}
              >
                Remove
              </Button>
            }
          />
        ))}
        <Button variant="light" size="xs" onClick={() => set([...items, ""])}>
          {addLabel}
        </Button>
      </Stack>
    </SettingRow>
  );
};

/** Shows its children only while a setting has a given value. */
export const When = ({
  name,
  is,
  children,
}: {
  name: IntentField;
  is: unknown;
  children: ReactNode;
}) => (useWatch({ name }) === is ? <>{children}</> : null);

/**
 * The live value of a setting, e.g. in a table cell or a title. `format`
 * turns it into something to read; empty values show `fallback`.
 */
export const Value = ({
  name,
  fallback,
  format,
}: {
  name: IntentField;
  fallback?: ReactNode;
  format?: (value: any) => ReactNode;
}) => {
  const value = useWatch<any>({ name });
  const shown = format ? format(value) : value;
  return <>{shown === undefined || shown === "" ? fallback : shown}</>;
};

export { useIntentForm };

/**
 * A private IPv4 /24 ("10.0.0.0/24"): pick one of the three private ranges,
 * then only the parts it leaves free, each limited to what is valid there.
 */
const ranges = [
  { value: "10", label: "10.x.x.0", first: 10, second: [0, 255] },
  { value: "172", label: "172.16–31.x.0", first: 172, second: [16, 31] },
  { value: "192", label: "192.168.x.0", first: 192, second: [168, 168] },
] as const;

export const SubnetField = (row: RowProps) => {
  const field = useField(row.name);
  const [a, b, c] = String(field.value ?? "10.0.0.0/24")
    .split("/")[0]
    .split(".")
    .map(Number);
  const range = ranges.find((r) => r.first === a) ?? ranges[0];
  const set = (next: number[]) => field.onChange(`${next.join(".")}.0/24`);
  const octet = (value: number, min: number, max: number, onChange: (n: number) => void) => (
    <NumberInput
      value={value}
      min={min}
      max={max}
      clampBehavior="strict"
      allowDecimal={false}
      allowNegative={false}
      hideControls
      onChange={(n) => onChange(Number(n))}
      w={64}
    />
  );
  return (
    <SettingRow {...row} error={field.error}>
      <Group gap={6} wrap="nowrap">
        <Select
          data={ranges.map(({ value, label }) => ({ value, label }))}
          value={range.value}
          allowDeselect={false}
          onChange={(value) => {
            const next = ranges.find((r) => r.value === value)!;
            set([next.first, next.second[0], 0]);
          }}
          w={150}
        />
        {range.second[0] !== range.second[1] &&
          octet(b, range.second[0], range.second[1], (n) => set([a, n, c]))}
        {octet(c, 0, 255, (n) => set([a, b, n]))}
      </Group>
    </SettingRow>
  );
};

/** A duration like "12h": a whole number and a unit. */
const units = [
  { value: "m", label: "minutes" },
  { value: "h", label: "hours" },
  { value: "d", label: "days" },
];

export const DurationField = (row: RowProps) => {
  const field = useField(row.name);
  const match = /^(\d+)([mhd])$/.exec(String(field.value ?? ""));
  const amount = match ? Number(match[1]) : 12;
  const unit = match ? match[2] : "h";
  return (
    <SettingRow {...row} error={field.error}>
      <Group gap={6} wrap="nowrap">
        <NumberInput
          value={amount}
          min={1}
          allowDecimal={false}
          allowNegative={false}
          onChange={(n) => field.onChange(`${Number(n) || 1}${unit}`)}
          w={90}
        />
        <Select
          data={units}
          value={unit}
          allowDeselect={false}
          onChange={(next) => field.onChange(`${amount}${next}`)}
          w={110}
        />
      </Group>
    </SettingRow>
  );
};

/**
 * A choice that also fills in other settings, which stay adjustable: e.g. a
 * network's purpose sets its access switches. `presets[value]` is written to
 * `fills` when that value is picked.
 */
export const PresetField = <T extends string>({
  options,
  fills,
  presets,
  ...row
}: RowProps & {
  options: Option<T>[];
  fills: IntentField;
  presets: Record<T, unknown>;
}) => {
  const field = useField(row.name);
  const { setValue } = useIntentForm();
  return (
    <SettingRow {...row} error={field.error}>
      <SegmentedControl
        data={options}
        value={field.value}
        onChange={(value) => {
          field.onChange(value);
          setValue(fills, presets[value as T] as never, {
            shouldDirty: true,
            shouldValidate: true,
          });
        }}
      />
    </SettingRow>
  );
};

/**
 * A pick from another list in the intent, stored by a stable key: e.g. which
 * network a Wi-Fi joins, kept as the network's id and shown by its name.
 */
export const ReferenceField = ({
  to,
  valueKey,
  labelKey,
  ...row
}: RowProps & { to: IntentField; valueKey: string; labelKey: string }) => {
  const items: Record<string, any>[] = useWatch<any>({ name: to }) ?? [];
  return (
    <SelectField
      {...row}
      options={items.map((item) => ({
        value: String(item[valueKey]),
        label: item[labelKey] || "Unnamed",
      }))}
    />
  );
};

/** Several choices from a list, e.g. the networks in a zone. */
export const MultiSelectField = ({
  options,
  placeholder,
  ...row
}: RowProps & { options: Option<string>[]; placeholder?: string }) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <MultiSelect
        data={options}
        value={field.value ?? []}
        onChange={field.onChange}
        placeholder={placeholder}
        error={!!field.error}
        style={control.wide}
      />
    </SettingRow>
  );
};

/**
 * A list of short values typed one by one, e.g. addresses. Empty is left out
 * of the file rather than saved as [].
 */
export const TagsField = ({
  placeholder,
  ...row
}: RowProps & { placeholder?: string }) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <TagsInput
        value={field.value ?? []}
        onChange={(values) => field.onChange(values.length ? values : undefined)}
        placeholder={placeholder}
        error={!!field.error}
        style={control.wide}
      />
    </SettingRow>
  );
};

/**
 * A switch for whether `value` is in a list setting; `inverted` when the list
 * names what is off (e.g. built-in rules switched off).
 */
export const ListToggleField = ({
  value,
  inverted,
  ...row
}: RowProps & { value: string; inverted?: boolean }) => {
  const field = useField(row.name);
  const list: string[] = field.value ?? [];
  const present = list.includes(value);
  return (
    <SettingRow {...row} error={field.error}>
      <Switch
        checked={inverted ? !present : present}
        onChange={() =>
          field.onChange(present ? list.filter((v) => v !== value) : [...list, value])
        }
        size="md"
      />
    </SettingRow>
  );
};
