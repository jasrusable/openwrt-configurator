// Page structure, in the style of macOS System Settings: a page is a title
// and grouped sections; a section is a card of rows; a row is a label (and
// an explanation) on the left, its control on the right.
import { Anchor, Box, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { ReactNode } from "react";
import "./kit.css";

export type Crumb = { label: ReactNode; onClick?: () => void };

export const SettingsPage = ({
  title,
  description,
  actions,
  wide,
  children,
}: {
  /**
   * The page's name, or the path to it for a nested page, which reads as
   * "Networks / Home" with each earlier step a link back.
   */
  title: ReactNode | Crumb[];
  description?: ReactNode;
  /** At the right of the title: Add on a list, Remove on an item. */
  actions?: ReactNode;
  /** For tables and the pages nested in them, which want the room. */
  wide?: boolean;
  children: ReactNode;
}) => (
  <Stack gap="xl" maw={wide ? 1040 : 720} mx="auto" py="lg" px="md">
    <Box>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Title order={2}>
          {Array.isArray(title) ? <Crumbs crumbs={title} /> : title}
        </Title>
        {actions && (
          <Group gap="xs" wrap="nowrap">
            {actions}
          </Group>
        )}
      </Group>
      {description && (
        <Text c="dimmed" mt={4}>
          {description}
        </Text>
      )}
    </Box>
    {children}
  </Stack>
);

const Crumbs = ({ crumbs }: { crumbs: Crumb[] }) => (
  <>
    {crumbs.map((crumb, i) => (
      <span key={i}>
        {i > 0 && (
          <Text span inherit c="dimmed" mx={8} fw={400}>
            /
          </Text>
        )}
        {crumb.onClick ? (
          // A button, not a bare <a>: focusable, and announced as actionable.
          <Anchor
            component="button"
            type="button"
            inherit
            c="dimmed"
            underline="hover"
            onClick={crumb.onClick}
          >
            {crumb.label}
          </Anchor>
        ) : (
          crumb.label
        )}
      </span>
    ))}
  </>
);

export const Section = ({
  title,
  description,
  actions,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  /** Shown at the right of the title, like an "Add" button. */
  actions?: ReactNode;
  children: ReactNode;
}) => {
  return (
    <Stack gap={6}>
      {(title || actions) && (
        <Group justify="space-between" px={4}>
          {title && (
            <Text fw={600} size="sm">
              {title}
            </Text>
          )}
          {actions}
        </Group>
      )}
      <Paper withBorder radius="lg" className="onc-rows">
        {children}
      </Paper>
      {description && (
        <Text size="xs" c="dimmed" px={4}>
          {description}
        </Text>
      )}
    </Stack>
  );
};

export const SettingRow = ({
  label,
  description,
  error,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  children?: ReactNode;
}) => (
  <Group justify="space-between" wrap="nowrap" gap="md" px="md" py="sm" mih={52}>
    <Box style={{ flex: 1, minWidth: 0 }}>
      <Text size="sm">{label}</Text>
      {description && (
        <Text size="xs" c="dimmed">
          {description}
        </Text>
      )}
      {error && (
        <Text size="xs" c="red">
          {error}
        </Text>
      )}
    </Box>
    <Box style={{ flexShrink: 0, maxWidth: "60%" }}>{children}</Box>
  </Group>
);
