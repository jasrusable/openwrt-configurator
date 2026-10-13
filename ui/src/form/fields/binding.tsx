// What every bound field shares: its row (label, ⓘ, error), the rules for
// its setting (src/intent/choices.ts), and reading and writing its value in
// the draft. Each kind of control is in its own file beside this.
import { Anchor, Badge, Box, Button, Stack, Text } from "@mantine/core";
import { Hint } from "../../kit/Hint";
import { cloneElement, isValidElement, ReactNode } from "react";
import { SettingRow, useRowAria } from "../../kit/layout";
import { availability, Availability, inUse } from "../../../../src/intent/choices";
import { explainFor, fieldInfo } from "../../../../src/intent/fields";
import { Intent } from "../../../../src/intent/schema";
import { getIn, IntentField, useDerived, useDraft, useFieldError } from "../draft";
import { Override, overridesAt, overrideText } from "../../../../src/intent/patches/marks";
import { useFacts, useFixSwitch } from "../../fixes";

/** Control widths: fixed in a wide row, shrinking to fit a narrow one. */
export const control = {
  wide: { width: 260, maxWidth: "100%" },
  narrow: { width: 160, maxWidth: "100%" },
};

export type RowProps = {
  name: IntentField;
  /** Its name and line of description, when not the ones src/intent/fields.ts gives it. */
  label?: ReactNode;
  /** What OpenWrt calls it, when not the same for every item (src/intent/fields.ts has the rest). */
  openwrt?: string;
  description?: ReactNode;
  /** Just the control, e.g. in a table cell; the label becomes its name. */
  inline?: boolean;
};

/** What src/intent/fields.ts calls a setting, as a row's label (a list item's is its name, not this). */
export const labelOf = (name: string) => {
  const label = fieldInfo(name.split("."))?.label;
  return typeof label === "string" ? label : undefined;
};

/**
 * The fixes overriding a setting now (src/intent/patches/marks.ts), across
 * the devices as their facts say; derived from the draft, so turning a fix
 * off shows at once.
 */
export const useOverrides = (name: IntentField): Override[] => {
  const facts = useFacts();
  const path = name.split(".");
  // Re-rendered only when what the overrides say changes.
  useDerived((d) =>
    JSON.stringify(overridesAt(d.value, facts, path).map((o) => [o.patch.id, o.overridden, o.reached, o.unknown, o.everywhere]))
  );
  const draft = useDraft();
  return overridesAt(draft.value, facts, path);
};

/** A fix overriding a setting: a chip, its card saying what, until when, where and why; an optional fix can be turned off from it. */
const OverrideChip = ({ override }: { override: Override }) => {
  const { turnOff } = useFixSwitch();
  const { patch } = override;
  const reference = patch.references[0];
  return (
    <Hint
      width={300}
      label={
        <Stack gap={6}>
          <Text size="xs">{overrideText(override)}</Text>
          {reference && (
            <Anchor href={reference.url} target="_blank" rel="noreferrer" size="xs">
              Why ↗
            </Anchor>
          )}
          {!patch.required && (
            <Button variant="light" color="gray" size="compact-xs" onClick={() => turnOff(patch.id)}>
              Turn this fix off
            </Button>
          )}
        </Stack>
      }
    >
      <Badge variant="light" color="orange" size="xs" radius="sm" style={{ textTransform: "none", cursor: "help" }} tabIndex={0}>
        Fix
      </Badge>
    </Hint>
  );
};

/** A setting's row, with its ⓘ: what it does and what OpenWrt calls it (src/intent/fields.ts). */
export const FieldRow = ({
  name,
  unavailable,
  children,
  ...props
}: Omit<Parameters<typeof SettingRow>[0], "label"> & {
  name: IntentField;
  label?: ReactNode;
  unavailable?: string;
}) => {
  const path = name.split(".");
  const info = fieldInfo(path);
  // A string, so only a change to the explainer itself re-renders the row.
  const explain = useDerived((d) => explainFor(path, d.value));
  const overrides = useOverrides(name);
  return (
    <SettingRow
      {...props}
      label={props.label ?? labelOf(name)}
      description={props.description ?? info?.description}
      openwrt={props.openwrt ?? info?.openwrt}
      explain={explain}
      marks={overrides.length ? overrides.map((o) => <OverrideChip key={o.patch.id} override={o} />) : undefined}
    >
      <Because reason={unavailable}>
        <Named>{children}</Named>
      </Because>
    </SettingRow>
  );
};

/** The control, named by its row's label and described by its text, for screen readers. */
export const Named = ({ children }: { children: ReactNode }) => {
  const aria = useRowAria();
  return isValidElement(children) ? cloneElement(children, aria) : <>{children}</>;
};

/**
 * A control that cannot be changed now: greyed out by its own disabled
 * state, with why in a tooltip. Disabled controls get no pointer events, so
 * the tooltip and the not-allowed cursor are on a wrapper.
 */
export const Because = ({ reason, children }: { reason?: string; children: ReactNode }) =>
  reason ? (
    <Hint label={reason} width={280}>
      <Box component="span" tabIndex={0} style={{ display: "inline-block", cursor: "not-allowed" }}>
        <Box component="span" style={{ display: "contents", pointerEvents: "none" }}>
          {children}
        </Box>
      </Box>
    </Hint>
  ) : (
    <>{children}</>
  );

/** Options with the rules applied (src/intent/choices.ts): greyed out with why, or what else choosing one changes. */
export const withRules = <T,>(options: Option<T>[], option: Availability["option"]) =>
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
      <Hint label={reason} width={260}>
        {/* Over the segment's padding too, so hovering anywhere on it shows why. */}
        <span style={{ pointerEvents: "auto", display: "block", margin: "-3px -10px", padding: "3px 10px" }}>
          {label}
        </span>
      </Hint>
    ) : (
      label
    ),
  }));

/** A list option's label, with why it is greyed out (or what it changes) beneath. */
export const optionWithReason = (reasons: Record<string, string | undefined>) =>
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
export const Row = ({
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

/** The rules for a setting (src/intent/choices.ts), worked out once per draft value and path. */
export const ruled = new WeakMap<object, Map<string, Availability>>();

export const rulesOf = (intent: Intent, path: IntentField): Availability => {
  const byPath = ruled.get(intent) ?? new Map<string, Availability>();
  ruled.set(intent, byPath);
  if (!byPath.has(path)) byPath.set(path, availability(intent, path));
  return byPath.get(path)!;
};

/**
 * The rules for a setting, re-rendering only when what they say about it
 * changes: as a whole, and for each value in `shown` (the choices on screen).
 * Typing elsewhere then re-renders no other field.
 */
export const useRules = (path: IntentField, shown: unknown[] = []) => {
  const draft = useDraft();
  useDerived((d) => {
    const rules = rulesOf(d.value, path);
    return JSON.stringify([
      rules.unavailable,
      shown.map((value) => {
        const { unavailable, swap } = rules.option(value);
        return [unavailable, swap?.note];
      }),
    ]);
  });
  return rulesOf(draft.value, path);
};

/** A setting's value as each kind of control shows it: text, a list of texts, a number. */
export const asText = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "");

export const asTexts = (value: unknown) => (Array.isArray(value) ? value.map(String) : []);

export const asNumber = (value: unknown) => (typeof value === "number" ? value : "");

/**
 * A setting's value, its problem, how to change it, and what the rules
 * (src/intent/choices.ts) allow: choosing a value that swaps applies the
 * whole swap, so the draft never passes through a broken state. `shown`:
 * the values whose rules the control shows, given its value.
 */
export const useField = (name: IntentField, shown?: (value: unknown) => unknown[]) => {
  const draft = useDraft();
  // Whatever the setting holds: each control reads it as its own kind (the readers below).
  const value: unknown = useDerived((d) => getIn(d.value, name));
  const rules = useRules(name, shown?.(value));
  const whole = rules.unavailable;
  // A fix overriding it on every device it reaches: greyed out, its value kept for when the fix goes.
  const heldOff = useOverrides(name).find((o) => o.everywhere);
  return {
    value,
    onChange: (next: unknown) => {
      const swap = rulesOf(draft.value, name).option(next).swap;
      if (swap) draft.replace(swap.apply(draft.get()));
      else draft.setPath(name, next);
    },
    error: useFieldError(name),
    /**
     * Why it cannot be changed now. A refused value already set stays
     * editable, so it can be cleared; an ignored one is greyed out and kept.
     */
    unavailable: whole && !(whole.refuses && inUse(value)) ? whole.reason : heldOff ? overrideText(heldOff) : undefined,
    /** Whether its value is ignored for now (shown off, kept for later). */
    ignored: !!whole && !whole.refuses,
    option: rules.option,
  };
};

/** A choice; one the page itself greys out (a port another connection uses) says why in `reason`. */
export type Option<T> = { value: T; label: string; disabled?: boolean; reason?: string };
