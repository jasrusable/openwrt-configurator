// Settings bound to the intent by name: <TextField name="site.name" />. Each
// renders a SettingRow with its control and its validation error, so a page
// only says which settings it shows, in what order, and how they are labelled.
import {
  Button,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Switch,
  TextInput,
} from "@mantine/core";
import { ReactNode } from "react";
import { useController, useWatch } from "react-hook-form";
import { SettingRow } from "../kit/layout";
import { IntentField, useIntentForm } from "./IntentForm";

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
        w={260}
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
        w={260}
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
        w={160}
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
        w={260}
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
      <Stack gap={6} w={260}>
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

/** The live value of a setting, as text, e.g. in a section's title. */
export const Value = ({ name, fallback }: { name: IntentField; fallback?: string }) => {
  const value = useWatch<any>({ name });
  return <>{value || fallback}</>;
};

export { useIntentForm };
