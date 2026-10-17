// A list edited in place, a row per item (reserved addresses, local names):
// each control is bound to its own setting, so its problem shows on it as
// it is typed, as any field's does.
import { Box, Button, Group, Text, TextInput } from "@mantine/core";
import { ReactNode } from "react";
import { IntentField } from "../draft";
import { asText, useField } from "./binding";

/** A name as DNS takes it (nas, printer-2): lower case, letters, digits and hyphens; others dropped as typed. */
export const dnsLabel = (typed: string) => typed.toLowerCase().replace(/[^a-z0-9-]/g, "");

/** Remove, beside an item edited in place: the same wherever a list is. */
export const RemoveItem = ({ onClick, label }: { onClick: () => void; label?: string }) => (
  <Button variant="subtle" color="red" size="compact-sm" mt={6} onClick={onClick} aria-label={label}>
    Remove
  </Button>
);

/** Its columns' names, each as wide as its controls (`flex`). */
export const ItemColumns = ({ columns }: { columns: { label: string; flex: number }[] }) => (
  <Group gap="xs" px="md" pt="sm" wrap="nowrap">
    {columns.map(({ label, flex }) => (
      <Text key={label} size="xs" c="dimmed" fw={500} style={{ flex }}>
        {label}
      </Text>
    ))}
    {/* Remove's width, so the names stand over their controls. */}
    <Box style={{ visibility: "hidden" }} aria-hidden>
      <RemoveItem onClick={() => {}} />
    </Box>
  </Group>
);

/** One item: its controls, then Remove. */
export const ItemRow = ({ children, onRemove, removeLabel }: { children: ReactNode; onRemove: () => void; removeLabel?: string }) => (
  <Group gap="xs" px="md" py="sm" wrap="nowrap" align="flex-start">
    {children}
    <RemoveItem onClick={onRemove} label={removeLabel} />
  </Group>
);

/** A line of text in an item's row, bound to its setting; `tidy` cleans what is typed. */
export const ItemText = ({
  name,
  label,
  placeholder,
  tidy,
  flex = 1,
  mono,
}: {
  name: IntentField;
  /** Its column's name, for screen readers. */
  label: string;
  placeholder?: string;
  tidy?: (typed: string) => string;
  flex?: number;
  mono?: boolean;
}) => {
  const field = useField(name);
  return (
    <TextInput
      aria-label={label}
      placeholder={placeholder}
      value={asText(field.value)}
      disabled={!!field.unavailable}
      // An item's text is required: cleared is "", which the schema names.
      onChange={(e) => field.onChange(tidy ? tidy(e.currentTarget.value) : e.currentTarget.value)}
      error={field.error}
      spellCheck={false}
      ff={mono ? "monospace" : undefined}
      style={{ flex }}
    />
  );
};
