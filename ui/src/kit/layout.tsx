// Page structure, in the style of macOS System Settings: a page is a title
// and grouped sections; a section is a card of rows; a row is a label (and
// an explanation) on the left, its control on the right.
import { Box, Group, Paper, Stack, Text, Title } from "@mantine/core";
import { ReactNode } from "react";
import "./kit.css";

export const SettingsPage = ({
  title,
  description,
  breadcrumbs,
  wide,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** Above the title, for a page nested in another (e.g. one Wi-Fi network). */
  breadcrumbs?: ReactNode;
  /** For tables, which want the room. */
  wide?: boolean;
  children: ReactNode;
}) => (
  <Stack gap="xl" maw={wide ? 1040 : 720} mx="auto" py="lg" px="md">
    <Box>
      {breadcrumbs && <Box mb={6}>{breadcrumbs}</Box>}
      <Title order={2}>{title}</Title>
      {description && (
        <Text c="dimmed" mt={4}>
          {description}
        </Text>
      )}
    </Box>
    {children}
  </Stack>
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
