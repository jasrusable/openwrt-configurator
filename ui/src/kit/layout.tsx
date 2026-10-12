// Page structure, in the style of macOS System Settings: a page is a title
// and grouped sections; a section is a card of rows; a row is a label (and
// an explanation) on the left, its control on the right.
import { Anchor, Box, Group, Paper, Stack, Text, ThemeIcon, Title, Tooltip } from "@mantine/core";
import { IconInfoCircle } from "@tabler/icons-react";
import { createContext, ReactNode, useContext } from "react";
import "./kit.css";

export type Crumb = { label: ReactNode; onClick?: () => void };

/**
 * Shown above the title of every page inside a section, e.g. the Firewall's
 * tabs, so a section's pages, and the items nested in them, share them.
 */
export const SectionNav = createContext<ReactNode>(null);

export const SettingsPage = ({
  title,
  description,
  actions,
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
  children: ReactNode;
}) => (
  // One width for every page, tables or not, so nothing shifts between them.
  <Stack gap="xl" maw={1040} mx="auto" py="lg" px="md">
    <Box>
      <SectionNavSlot />
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

const SectionNavSlot = () => {
  const nav = useContext(SectionNav);
  return nav ? <Box mb="lg">{nav}</Box> : null;
};

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
  openwrt,
  explain,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  /** What OpenWrt calls it, at the foot of the ⓘ tooltip beside the label, for people who know LuCI. */
  openwrt?: string;
  /** What it does on the devices, in more depth than the description: the tooltip's body. */
  explain?: string;
  children?: ReactNode;
}) => (
  <Group justify="space-between" wrap="nowrap" gap="md" px="md" py="sm" mih={52}>
    <Box style={{ flex: 1, minWidth: 0 }}>
      <Group gap={4} wrap="nowrap">
        <Text size="sm">{label}</Text>
        {(explain || openwrt) && (
          <Tooltip
            label={
              <Stack gap={6}>
                {explain && <Text size="xs">{explain}</Text>}
                {openwrt && (
                  <Text size="xs" c="gray.4" ff="monospace">
                    OpenWrt: {openwrt}
                  </Text>
                )}
              </Stack>
            }
            multiline
            w={320}
            withArrow
            openDelay={150}
            events={{ hover: true, focus: true, touch: true }}
          >
            <ThemeIcon
              variant="transparent"
              size={16}
              c="gray.5"
              tabIndex={0}
              aria-label={[explain, openwrt && `OpenWrt: ${openwrt}`].filter(Boolean).join(" ")}
            >
              <IconInfoCircle size={14} stroke={1.6} />
            </ThemeIcon>
          </Tooltip>
        )}
      </Group>
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
