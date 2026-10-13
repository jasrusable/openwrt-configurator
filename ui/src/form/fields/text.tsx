// Text controls bound to a setting: a line of text, a password, a list of
// passwords, a subnet (typed as the router's address), tags.
import { Button, PasswordInput, Stack, TagsInput, Text, TextInput } from "@mantine/core";
import { parseSubnet } from "../../../../src/intent/validators";
import { control, RowProps, FieldRow, asText, asTexts, useField } from "./binding";

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
        value={asText(field.value)}
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
        value={asText(field.value)}
        // Cleared is unset: "" would fail a pattern an optional field allows.
        onChange={(e) => field.onChange(e.currentTarget.value || undefined)}
        error={!!field.error}
        style={control.wide}
      />
    </FieldRow>
  );
};

/** A list of strings, edited one row each, e.g. extra Wi-Fi passwords. */
export const PasswordListField = ({
  addLabel,
  ...row
}: RowProps & { addLabel: string }) => {
  const field = useField(row.name);
  const items = asTexts(field.value);
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
        value={asTexts(field.value)}
        onChange={(values) => field.onChange(values.length ? values : undefined)}
        placeholder={placeholder}
        error={!!field.error}
        style={control.wide}
      />
    </FieldRow>
  );
};
