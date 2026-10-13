// Choices bound to a setting: a switch, a select, segments, a variant (a
// setting whose shape follows its type), an optional group, a reference to
// another list's item, several choices.
import { MultiSelect, SegmentedControl, Select, Switch } from "@mantine/core";
import { ReactNode, useRef } from "react";
import { getAt, IntentField, useDerived } from "../draft";
import { control, RowProps, FieldRow, withRules, segments, optionWithReason, Row, useRules, asText, asTexts, useField, Option } from "./binding";

export const SwitchField = ({
  disabled,
  ...row
}: RowProps & {
  /** Greyed out and shown off, its value kept for when it applies again. */
  disabled?: boolean;
}) => {
  const field = useField(row.name, (value) => [!value]);
  // Off when ignored; otherwise its value, and whether flipping it is allowed.
  const off = disabled || field.ignored;
  const reason = field.unavailable ?? (off ? undefined : field.option(!field.value).unavailable);
  return (
    <Row row={row} error={field.error} unavailable={reason}>
      <Switch
        disabled={off || !!reason}
        checked={!off && !!field.value}
        onChange={(e) => field.onChange(e.currentTarget.checked)}
        aria-label={typeof row.label === "string" ? row.label : undefined}
        size="md"
      />
    </Row>
  );
};

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
  const field = useField(row.name, () => [undefined, ...options.map((o) => o.value)]);
  const empty = "\u0000";
  const choices = withRules(options, field.option);
  // The unset choice is ruled like any other (the WAN port another connection has).
  const unset = field.option(undefined).unavailable;
  const data = [
    ...(emptyLabel ? [{ value: empty, label: emptyLabel, disabled: !!unset }] : []),
    ...choices.map((option) => ({
      value: String(option.value),
      label: option.label,
      disabled: option.disabled,
    })),
  ];
  return (
    <Row row={row} error={field.error} unavailable={field.unavailable}>
      <Select
        data={data}
        disabled={!!field.unavailable}
        renderOption={optionWithReason({
          ...Object.fromEntries(choices.map((o) => [String(o.value), o.reason])),
          [empty]: unset,
        })}
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
  const field = useField(row.name, () => options.map((o) => o.value));
  return (
    <Row row={row} error={field.error} unavailable={field.unavailable}>
      <SegmentedControl
        data={segments(withRules(options, field.option))}
        disabled={!!field.unavailable}
        value={asText(field.value)}
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
  within = false,
  ...row
}: RowProps & {
  variants: (Option<T["type"]> & { initial: T })[];
  /**
   * The variants' settings sit beside others in the same object (a line's
   * name and port beside its type's own settings): switching keeps those and
   * swaps only the keys the variants bring.
   */
  within?: boolean;
}) => {
  const field = useField(row.name);
  const variantKeys = new Set(variants.flatMap((v) => Object.keys(v.initial)));
  const switched = (initial: T) =>
    within
      ? { ...Object.fromEntries(Object.entries((field.value ?? {}) as object).filter(([key]) => !variantKeys.has(key))), ...initial }
      : initial;
  // The rules are about the variant's type (e.g. dns.upstream.type).
  const types = useRules(
    // A variant field's name is an object with a type; its type's rules are by that path.
    `${row.name}.type` as IntentField,
    variants.map((v) => v.value)
  );
  return (
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <SegmentedControl
        data={segments(withRules(variants.map(({ value, label }) => ({ value, label })), types.option))}
        disabled={!!field.unavailable}
        value={asText((field.value as { type?: unknown } | undefined)?.type)}
        onChange={(type) =>
          field.onChange(switched(variants.find((variant) => variant.value === type)!.initial))
        }
      />
    </FieldRow>
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
      <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
        <Switch
          checked={on}
          disabled={!!field.unavailable}
          onChange={(e) =>
            field.onChange(e.currentTarget.checked ? (last.current ?? initial) : undefined)
          }
          size="md"
        />
      </FieldRow>
      {on && children}
    </>
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
  const items = (useDerived((d) => getAt(d.value, to)) ?? []) as Record<string, unknown>[];
  return (
    <SelectField
      {...row}
      options={items.map((item) => ({
        value: String(item[valueKey]),
        label: String(item[labelKey] || "Unnamed"),
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
  const field = useField(row.name, () => options.map((o) => o.value));
  const choices = withRules(options, field.option);
  return (
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <MultiSelect
        data={choices.map(({ value, label, disabled }) => ({ value, label, disabled }))}
        renderOption={optionWithReason(Object.fromEntries(choices.map((o) => [o.value, o.reason])))}
        disabled={!!field.unavailable}
        value={asTexts(field.value)}
        onChange={(values) =>
          field.onChange(emptyIsUnset && values.length === 0 ? undefined : values)
        }
        placeholder={placeholder}
        error={!!field.error}
        style={control.wide}
      />
    </FieldRow>
  );
};
