// Page structure, in the style of macOS System Settings: a page is a title
// and grouped sections; a section is a card of rows; a row is a label (and
// an explanation) on the left, its control on the right.
import { Anchor, Badge, Box, Group, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { Hint } from "./Hint";
import { IconInbox, IconInfoCircle } from "@tabler/icons-react";
import { createContext, ReactNode, useContext, useId } from "react";
import "./kit.css";

export type Crumb = { label: ReactNode; onClick?: () => void };

/**
 * Shown above the title of every page inside a section, e.g. the Firewall's
 * tabs, so a section's pages, and the items nested in them, share them.
 */
export const SectionNav = createContext<ReactNode>(null);

/** Inside a section's card: a table there draws no card of its own, so it never doubles up. */
export const InCard = createContext(false);

/** A page's icon on its colour, as macOS Settings draws them: the sidebar, and beside a page's title. */
export type PageMark = { icon: typeof IconInbox; color: string };

export const AppIcon = ({ icon: Icon, color, size = 22 }: PageMark & { size?: number }) => (
  <ThemeIcon size={size} radius={Math.round(size * 0.27)} color={color} variant="filled" aria-hidden>
    <Icon size={Math.round(size * 0.66)} stroke={1.9} />
  </ThemeIcon>
);


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
  // One width for every page, tables or not, so nothing shifts between them;
  // narrow enough that a label and its control read as one row.
  <Stack gap="xl" maw={760} mx="auto" py="lg" px="md">
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
    <Stack gap={8}>
      {(title || actions) && (
        <Group justify="space-between" px={4} mih={22}>
          {title && (
            <Text fw={600} size="sm" className="onc-section-title">
              {title}
            </Text>
          )}
          {actions}
        </Group>
      )}
      <div className="onc-card onc-rows">
        <InCard.Provider value={true}>{children}</InCard.Provider>
      </div>
      {description && (
        <Text size="xs" c="dimmed" px={4}>
          {description}
        </Text>
      )}
    </Stack>
  );
};

/** The ids of the row a control is in, so it is named by the row's label and described by its text. */
const RowIds = createContext<{ label: string; description: string } | null>(null);

/** A control's accessible name and description, from the row it is in. */
export const useRowAria = () => {
  const ids = useContext(RowIds);
  return ids ? { "aria-labelledby": ids.label, "aria-describedby": ids.description } : {};
};

/** An explainer's text with each URL (a patch's reference) as a short "why" link. */
const withWhyLinks = (text: string) =>
  text.split(/(https:\/\/\S+?)(?=[.,;)]?(?:\s|$))/).map((part, i) =>
    /^https:\/\//.test(part) ? (
      <Anchor key={i} href={part} target="_blank" rel="noreferrer" size="xs">
        why ↗
      </Anchor>
    ) : (
      part
    )
  );

export const SettingRow = ({
  label,
  description,
  error,
  openwrt,
  explain,
  marks,
  setting,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  error?: string;
  /** What OpenWrt calls it, at the foot of the ⓘ tooltip beside the label, for people who know LuCI. */
  openwrt?: string;
  /** What it does on the devices, in more depth than the description: the tooltip's body. */
  explain?: string;
  /** Beside the label: what overrides it now (a fix's chip, src/intent/patches/marks.ts). */
  marks?: ReactNode;
  /** The setting it edits (a dotted path): where a link to it lands (form/landing.ts). */
  setting?: string;
  children?: ReactNode;
}) => {
  const id = useId();
  const ids = { label: `${id}-label`, description: `${id}-description` };
  return (
    <Group justify="space-between" gap="md" px="md" py={10} mih={52} className="onc-row" data-setting={setting}>
      <Box style={{ flex: 1, minWidth: 0 }}>
        <Group gap={4} wrap="nowrap">
          {/* A div: a label may be an icon and a name, which a paragraph cannot hold. */}
          <Text component="div" size="sm" id={ids.label}>
            {label}
          </Text>
          {(explain || openwrt) && (
            // A card that stays open while the pointer is on it, so a patch's
            // "why" link in the explainer can be followed.
            <Hint
              label={
                <Stack gap={6}>
                  {explain && <Text size="xs">{withWhyLinks(explain)}</Text>}
                  {openwrt && (
                    <Text size="xs" ff="monospace" c="dimmed">
                      OpenWrt: {openwrt}
                    </Text>
                  )}
                </Stack>
              }
            >
                <ThemeIcon
                  variant="transparent"
                  size={16}
                  c="var(--onc-label-2)"
                  tabIndex={0}
                  aria-label={[explain, openwrt && `OpenWrt: ${openwrt}`].filter(Boolean).join(" ")}
                >
                  <IconInfoCircle size={14} stroke={1.6} />
                </ThemeIcon>
            </Hint>
          )}
          {marks}
        </Group>
        <Box id={ids.description}>
          {description && (
            // A div: a description may hold a control, which a paragraph cannot.
            <Text component="div" size="xs" c="dimmed">
              {description}
            </Text>
          )}
          {error && (
            <Text size="xs" c="red">
              {error}
            </Text>
          )}
        </Box>
      </Box>
      {children && (
        <Box className="onc-row-control">
          <RowIds.Provider value={ids}>{children}</RowIds.Provider>
        </Box>
      )}
    </Group>
  );
};

/** Nothing here yet: a quiet icon and a line, inside a card or a table. */
export const EmptyState = ({ icon: Icon = IconInbox, children }: { icon?: typeof IconInbox; children: ReactNode }) => (
  <Stack align="center" gap={6} py="xl" px="md">
    <Icon size={28} stroke={1.4} color="var(--onc-label-2)" />
    <Text size="sm" c="dimmed" ta="center">
      {children}
    </Text>
  </Stack>
);

/** What kind of thing a list row is: a tinted icon before its name, grey while it is off. */
export const ItemIcon = ({
  icon: Icon,
  color,
  off = false,
}: {
  icon: typeof IconInbox;
  color: string;
  off?: boolean;
}) => (
  <ThemeIcon size={28} radius={8} variant="light" color={off ? "gray" : color} aria-hidden>
    <Icon size={16} stroke={1.8} />
  </ThemeIcon>
);

/** A list row's first cell: its icon, then its name. */
export const ItemName = ({ icon, children }: { icon: ReactNode; children: ReactNode }) => (
  <Group gap={10} wrap="nowrap">
    {icon}
    <Text size="sm" fw={500} truncate>
      {children}
    </Text>
  </Group>
);

/** A small coloured dot for a state; always next to words, never the only cue. */
export const StatusDot = ({ color }: { color: "green" | "orange" | "red" | "gray" }) => (
  <Box
    component="span"
    w={8}
    h={8}
    style={{ display: "inline-block", flexShrink: 0, borderRadius: 4, background: `var(--mantine-color-${color}-6)` }}
  />
);

/** A title marked experimental: built and tested in containers, not yet on real routers. */
export const Experimental = ({ children }: { children: ReactNode }) => (
  <Group gap={8} component="span">
    {children}
    <ExperimentalBadge />
  </Group>
);

/** Marks something built but not yet run on a real router, with why in a tooltip. */
export const ExperimentalBadge = () => (
  <Hint
    label="Not yet tested on real routers: built to OpenWrt's documented setup and checked in containers only, so it may need fixes."
    width={280}
  >
    <Badge variant="light" color="orange" size="sm" tabIndex={0} style={{ cursor: "help" }}>
      Experimental
    </Badge>
  </Hint>
);
