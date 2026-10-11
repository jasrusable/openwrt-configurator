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
  Text,
  TextInput,
} from "@mantine/core";
import { ReactNode, useRef } from "react";
import { SettingRow } from "../kit/layout";
import { parseSubnet } from "../../../src/intent/schema";
import { IntentField, useDraft, useDraftValue, useFieldError } from "./draft";

/** Control widths: fixed in a wide row, shrinking to fit a narrow one. */
const control = {
  wide: { width: 260, maxWidth: "100%" },
  narrow: { width: 160, maxWidth: "100%" },
};

type RowProps = {
  name: IntentField;
  label: ReactNode;
  description?: ReactNode;
  /** Just the control, e.g. in a table cell; the label becomes its name. */
  inline?: boolean;
};

/** A control in its row, with its label and error; or alone, when inline. */
const Row = ({
  row,
  error,
  children,
}: {
  row: RowProps;
  error?: string;
  children: ReactNode;
}) =>
  row.inline ? (
    <>{children}</>
  ) : (
    <SettingRow label={row.label} description={row.description} error={error}>
      {children}
    </SettingRow>
  );

/** A setting's value, its problem, and how to change it. */
const useField = (name: IntentField) => {
  const draft = useDraft();
  return {
    value: useDraftValue(name),
    onChange: (value: unknown) => draft.set(name, value),
    onBlur: () => {},
    error: useFieldError(name),
  };
};

export const TextField = ({
  placeholder,
  chars,
  ...row
}: RowProps & {
  placeholder?: string;
  /** The characters it takes, e.g. /[\d.]/ for an IPv4 address; others are dropped as typed. */
  chars?: RegExp;
}) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <TextInput
        value={field.value ?? ""}
        // Cleared is unset: "" would fail a pattern an optional field allows.
        onChange={(e) => {
          const typed = e.currentTarget.value;
          const value = chars ? [...typed].filter((c) => chars.test(c)).join("") : typed;
          field.onChange(value || undefined);
        }}
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
        // Cleared is unset: "" would fail a pattern an optional field allows.
        onChange={(e) => field.onChange(e.currentTarget.value || undefined)}
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
  integer,
  ...row
}: RowProps & { unit?: string; min?: number; max?: number; integer?: boolean }) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <NumberInput
        value={field.value ?? ""}
        onChange={(value) => field.onChange(value === "" ? undefined : Number(value))}
        onBlur={field.onBlur}
        min={min}
        max={max}
        allowDecimal={!integer}
        allowNegative={min === undefined || min < 0}
        rightSection={unit}
        rightSectionWidth={unit ? 56 : undefined}
        error={!!field.error}
        style={control.narrow}
      />
    </SettingRow>
  );
};

export const SwitchField = ({
  disabled,
  ...row
}: RowProps & {
  /** Greyed out and shown off, its value kept for when it applies again. */
  disabled?: boolean;
}) => {
  const field = useField(row.name);
  return (
    <Row row={row} error={field.error}>
      <Switch
        disabled={disabled}
        checked={!disabled && !!field.value}
        onChange={(e) => field.onChange(e.currentTarget.checked)}
        aria-label={typeof row.label === "string" ? row.label : undefined}
        size="md"
      />
    </Row>
  );
};

export type Option<T> = { value: T; label: string; disabled?: boolean };

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
    ...options.map((option) => ({
      value: String(option.value),
      label: option.label,
      disabled: option.disabled,
    })),
  ];
  return (
    <Row row={row} error={field.error}>
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
        aria-label={typeof row.label === "string" ? row.label : undefined}
        style={row.inline ? undefined : control.wide}
      />
    </Row>
  );
};

export const SegmentedField = <T extends string>({
  options,
  ...row
}: RowProps & { options: Option<T>[] }) => {
  const field = useField(row.name);
  return (
    <Row row={row} error={field.error}>
      <SegmentedControl
        data={options}
        value={field.value}
        onChange={field.onChange}
        size={row.inline ? "xs" : "sm"}
      />
    </Row>
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
  // Off then on again brings back what it held, not the starting value.
  const last = useRef(field.value);
  if (on) last.current = field.value;
  return (
    <>
      <SettingRow {...row} error={field.error}>
        <Switch
          checked={on}
          onChange={(e) =>
            field.onChange(e.currentTarget.checked ? (last.current ?? initial) : undefined)
          }
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

/** Shows its children only while a setting has a value (`is`) or passes `test`. */
export const When = ({
  name,
  is,
  test,
  children,
}: {
  name: IntentField;
  is?: unknown;
  test?: (value: any) => boolean;
  children: ReactNode;
}) => {
  const value = useDraftValue(name);
  return (test ? test(value) : value === is) ? <>{children}</> : null;
};

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
  const value = useDraftValue(name);
  const shown = format ? format(value) : value;
  return <>{shown === undefined || shown === "" ? fallback : shown}</>;
};


/**
 * A private IPv4 /24 ("10.0.0.0/24"): pick one of the three private ranges,
 * then only the parts it leaves free, each limited to what is valid there.
 */
/**
 * A network's addresses, set the way people know them: by the router's
 * address (10.0.20.1), as UniFi does. Stored as the /24 it is in
 * ("10.0.20.0/24"); what is typed but not yet valid stays in the draft, so
 * the draft cannot be saved until it is.
 */
export const SubnetField = (row: RowProps) => {
  const field = useField(row.name);
  const toRouter = (subnet: unknown) =>
    typeof subnet === "string" && parseSubnet(subnet)
      ? subnet.replace(/\.0\/24$/, ".1")
      : String(subnet ?? "");
  const value = toRouter(field.value);
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  const subnet = match && `${match[1]}.${match[2]}.${match[3]}.0/24`;
  const problem = !match
    ? "an address like 10.0.20.1"
    : match[4] !== "1"
    ? "the router's address ends in .1"
    : !parseSubnet(subnet!)
    ? "a private range: 10.x.x.1, 172.16–31.x.1 or 192.168.x.1"
    : undefined;
  const prefix = match ? `${match[1]}.${match[2]}.${match[3]}` : "";
  return (
    <SettingRow
      {...row}
      description={row.description ?? (problem ? undefined : `Devices get ${prefix}.x addresses.`)}
      error={problem ?? field.error}
    >
      <TextInput
        value={value}
        onChange={(e) => {
          const typed = e.currentTarget.value.replace(/[^\d.]/g, "");
          const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.1$/.exec(typed);
          const candidate = m && `${m[1]}.${m[2]}.${m[3]}.0/24`;
          field.onChange(candidate && parseSubnet(candidate) ? candidate : typed);
        }}
        onBlur={field.onBlur}
        placeholder="10.0.20.1"
        rightSection={<Text size="sm" c="dimmed">/24</Text>}
        rightSectionWidth={44}
        error={!!(problem ?? field.error)}
        spellCheck={false}
        style={control.wide}
      />
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
  const draft = useDraft();
  return (
    <SettingRow {...row} error={field.error}>
      <SegmentedControl
        data={options}
        value={field.value}
        onChange={(value) => {
          field.onChange(value);
          draft.set(fills, presets[value as T]);
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
  const items: Record<string, any>[] = useDraftValue(to) ?? [];
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
  emptyIsUnset,
  ...row
}: RowProps & {
  options: Option<string>[];
  placeholder?: string;
  /** Nothing chosen leaves the setting out (e.g. "every band"). */
  emptyIsUnset?: boolean;
}) => {
  const field = useField(row.name);
  return (
    <SettingRow {...row} error={field.error}>
      <MultiSelect
        data={options}
        value={field.value ?? []}
        onChange={(values) =>
          field.onChange(emptyIsUnset && values.length === 0 ? undefined : values)
        }
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

