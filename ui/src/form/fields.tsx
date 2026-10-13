// Settings bound to the intent by name: <TextField name="system.name" />. Each
// renders a SettingRow with its control and its validation error, so a page
// only says which settings it shows, in what order, and how they are labelled.
import {
  Box,
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
  Tooltip,
} from "@mantine/core";
import { ReactNode, useMemo, useRef, useState } from "react";
import { SettingRow } from "../kit/layout";
import { availability, Availability, inUse } from "../../../src/intent/choices";
import { explainFor, fieldInfo } from "../../../src/intent/fields";
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
  /** What OpenWrt calls it, when not the same for every item (src/intent/fields.ts has the rest). */
  openwrt?: string;
  description?: ReactNode;
  /** Just the control, e.g. in a table cell; the label becomes its name. */
  inline?: boolean;
};

/** A setting's row, with its ⓘ: what it does and what OpenWrt calls it (src/intent/fields.ts). */
export const FieldRow = ({
  name,
  unavailable,
  children,
  ...props
}: Parameters<typeof SettingRow>[0] & { name: IntentField; unavailable?: string }) => {
  const path = name.split(".");
  const intent = useDraftValue();
  return (
    <SettingRow
      {...props}
      openwrt={props.openwrt ?? fieldInfo(path)?.openwrt}
      explain={explainFor(path, intent)}
    >
      <Because reason={unavailable}>{children}</Because>
    </SettingRow>
  );
};

/**
 * A control that cannot be changed now: greyed out by its own disabled
 * state, with why in a tooltip. Disabled controls get no pointer events, so
 * the tooltip and the not-allowed cursor are on a wrapper.
 */
export const Because = ({ reason, children }: { reason?: string; children: ReactNode }) =>
  reason ? (
    <Tooltip label={reason} multiline w={280} withArrow events={{ hover: true, focus: true, touch: true }}>
      <Box component="span" tabIndex={0} style={{ display: "inline-block", cursor: "not-allowed" }}>
        <Box component="span" style={{ display: "contents", pointerEvents: "none" }}>
          {children}
        </Box>
      </Box>
    </Tooltip>
  ) : (
    <>{children}</>
  );

/** Options with the rules applied (src/intent/choices.ts): greyed out with why, or what else choosing one changes. */
const ruled = <T,>(options: Option<T>[], option: Availability["option"]) =>
  options.map((o) => {
    const { unavailable, swap } = option(o.value);
    return { ...o, disabled: o.disabled || !!unavailable, reason: unavailable ?? swap?.note ?? o.reason };
  });

/** A segmented control's options, each with its reason in a tooltip. */
export const segments = <T extends string>(options: (Option<T> & { reason?: string })[]) =>
  options.map(({ value, label, disabled, reason }) => ({
    value,
    disabled,
    label: reason ? (
      <Tooltip label={reason} multiline w={260} withArrow events={{ hover: true, focus: true, touch: true }}>
        {/* Over the segment's padding too, so hovering anywhere on it shows why. */}
        <span style={{ pointerEvents: "auto", display: "block", margin: "-3px -10px", padding: "3px 10px" }}>
          {label}
        </span>
      </Tooltip>
    ) : (
      label
    ),
  }));

/** A list option's label, with why it is greyed out (or what it changes) beneath. */
const optionWithReason = (reasons: Record<string, string | undefined>) =>
  ({ option }: { option: { value: string; label: string } }) => (
    <Stack gap={0}>
      <Text size="sm">{option.label}</Text>
      {reasons[option.value] && (
        <Text size="xs" c="dimmed">
          {reasons[option.value]}
        </Text>
      )}
    </Stack>
  );

/** A control in its row, with its label and error; or alone, when inline. */
const Row = ({
  row,
  error,
  unavailable,
  children,
}: {
  row: RowProps;
  error?: string;
  unavailable?: string;
  children: ReactNode;
}) =>
  row.inline ? (
    <Because reason={unavailable}>{children}</Because>
  ) : (
    <FieldRow
      name={row.name}
      label={row.label}
      description={row.description}
      openwrt={row.openwrt}
      error={error}
      unavailable={unavailable}
    >
      {children}
    </FieldRow>
  );

/** The rules for a setting, given the draft (or the intent passed in). */
const useAvailability = (path: string, given?: unknown) => {
  const draftValue = useDraftValue();
  const intent = given ?? draftValue;
  return useMemo(() => availability(intent, path), [intent, path]);
};

/**
 * A setting's value, its problem, how to change it, and what the rules
 * (src/intent/choices.ts) allow: choosing a value that swaps applies the
 * whole swap, so the draft never passes through a broken state.
 */
const useField = (name: IntentField) => {
  const draft = useDraft();
  const intent = useDraftValue();
  const value = useDraftValue(name);
  const rules = useAvailability(name, intent);
  const whole = rules.unavailable;
  return {
    value,
    onChange: (next: unknown) => {
      const swap = rules.option(next).swap;
      if (swap) draft.replace(swap.apply(draft.get()));
      else draft.set(name, next);
    },
    error: useFieldError(name),
    /**
     * Why it cannot be changed now. A refused value already set stays
     * editable, so it can be cleared; an ignored one is greyed out and kept.
     */
    unavailable: whole && !(whole.refuses && inUse(value)) ? whole.reason : undefined,
    /** Whether its value is ignored for now (shown off, kept for later). */
    ignored: !!whole && !whole.refuses,
    option: rules.option,
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
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <TextInput
        disabled={!!field.unavailable}
        value={field.value ?? ""}
        // Cleared is unset: "" would fail a pattern an optional field allows.
        onChange={(e) => {
          const typed = e.currentTarget.value;
          const value = chars ? [...typed].filter((c) => chars.test(c)).join("") : typed;
          field.onChange(value || undefined);
        }}
        placeholder={placeholder}
        error={!!field.error}
        spellCheck={false}
        style={control.wide}
      />
    </FieldRow>
  );
};

export const PasswordField = (row: RowProps) => {
  const field = useField(row.name);
  return (
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <PasswordInput
        disabled={!!field.unavailable}
        value={field.value ?? ""}
        // Cleared is unset: "" would fail a pattern an optional field allows.
        onChange={(e) => field.onChange(e.currentTarget.value || undefined)}
        error={!!field.error}
        style={control.wide}
      />
    </FieldRow>
  );
};

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
        value={typing ?? field.value ?? ""}
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

export const SwitchField = ({
  disabled,
  ...row
}: RowProps & {
  /** Greyed out and shown off, its value kept for when it applies again. */
  disabled?: boolean;
}) => {
  const field = useField(row.name);
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

/** A choice; one the page itself greys out (a port another connection uses) says why in `reason`. */
export type Option<T> = { value: T; label: string; disabled?: boolean; reason?: string };

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
  const choices = ruled(options, field.option);
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
  const field = useField(row.name);
  return (
    <Row row={row} error={field.error} unavailable={field.unavailable}>
      <SegmentedControl
        data={segments(ruled(options, field.option))}
        disabled={!!field.unavailable}
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
      ? { ...Object.fromEntries(Object.entries(field.value ?? {}).filter(([key]) => !variantKeys.has(key))), ...initial }
      : initial;
  // The rules are about the variant's type (e.g. dns.upstream.type).
  const types = useAvailability(`${row.name}.type`);
  return (
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <SegmentedControl
        data={segments(ruled(variants.map(({ value, label }) => ({ value, label })), types.option))}
        disabled={!!field.unavailable}
        value={field.value?.type}
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

/** A list of strings, edited one row each, e.g. extra Wi-Fi passwords. */
export const PasswordListField = ({
  addLabel,
  ...row
}: RowProps & { addLabel: string }) => {
  const field = useField(row.name);
  const items: string[] = field.value ?? [];
  const set = (next: string[]) => field.onChange(next.length ? next : undefined);
  return (
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <Stack gap={6} style={control.wide}>
        {items.map((item, i) => (
          <PasswordInput
            key={i}
            value={item}
            disabled={!!field.unavailable}
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
        <Button
          variant="light"
          size="xs"
          disabled={!!field.unavailable}
          onClick={() => set([...items, ""])}
        >
          {addLabel}
        </Button>
      </Stack>
    </FieldRow>
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
    <FieldRow
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
        placeholder="10.0.20.1"
        rightSection={<Text size="sm" c="dimmed">/24</Text>}
        rightSectionWidth={44}
        error={!!(problem ?? field.error)}
        spellCheck={false}
        style={control.wide}
      />
    </FieldRow>
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
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <Group gap={6} wrap="nowrap">
        <NumberInput
          disabled={!!field.unavailable}
          value={amount}
          min={1}
          allowDecimal={false}
          allowNegative={false}
          onChange={(n) => field.onChange(`${Number(n) || 1}${unit}`)}
          w={90}
        />
        <Select
          disabled={!!field.unavailable}
          data={units}
          value={unit}
          allowDeselect={false}
          onChange={(next) => field.onChange(`${amount}${next}`)}
          w={110}
        />
      </Group>
    </FieldRow>
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
  const choices = ruled(options, field.option);
  return (
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <MultiSelect
        data={choices.map(({ value, label, disabled }) => ({ value, label, disabled }))}
        renderOption={optionWithReason(Object.fromEntries(choices.map((o) => [o.value, o.reason])))}
        disabled={!!field.unavailable}
        value={field.value ?? []}
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
    <FieldRow {...row} error={field.error} unavailable={field.unavailable}>
      <TagsInput
        disabled={!!field.unavailable}
        value={field.value ?? []}
        onChange={(values) => field.onChange(values.length ? values : undefined)}
        placeholder={placeholder}
        error={!!field.error}
        style={control.wide}
      />
    </FieldRow>
  );
};

