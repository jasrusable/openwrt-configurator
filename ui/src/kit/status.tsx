// The Status pages' pieces: a page that leads with its verdict, a value
// with the dot of its tone, facts as label and value, and a panel to hold a
// chart or a table. Colour means state only (src/status/health.ts: good,
// fair, poor, off), always beside words; what kind of thing something is
// goes in an icon or a word.
import { Anchor, Box, Group, SimpleGrid, Stack, Text, Title } from "@mantine/core";
import { MouseEvent, ReactNode } from "react";
import { Link } from "react-router";
import { settingUrl } from "../settingPages";
import type { Tone } from "../../../src/status/health";
import { Hint } from "./Hint";
import { Crumb, StatusDot } from "./layout";
import "./kit.css";

export const toneColor = { good: "green", fair: "orange", poor: "red", off: "gray" } as const satisfies Record<Tone, string>;

/** The two series colours, as validated for both schemes (indigo-6 and cyan-7: CVD ΔE 15). */
export const seriesColor = ["var(--mantine-color-indigo-6)", "var(--mantine-color-cyan-7)"] as const;

/** A tone's dot, with its meaning for a screen reader. */
export const ToneDot = ({ tone, label }: { tone: Tone; label?: string }) => (
  <Box component="span" aria-label={label} role={label ? "img" : undefined} style={{ display: "inline-flex" }}>
    <StatusDot color={toneColor[tone]} />
  </Box>
);

/** A value and its unit, with its tone's dot when it has one; the number in text colours. */
export const ToneValue = ({ tone, children, hint }: { tone?: Tone; children: ReactNode; hint?: ReactNode }) => {
  const value = (
    <Group gap={6} wrap="nowrap" component="span" style={{ display: "inline-flex" }}>
      {tone && tone !== "off" && <ToneDot tone={tone} />}
      <Text span size="sm" style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
        {children}
      </Text>
    </Group>
  );
  return hint ? (
    <Hint label={hint}>
      <span tabIndex={0}>{value}</span>
    </Hint>
  ) : (
    value
  );
};

/** How it is, in one line: a dot of its tone, the headline, and what to do about it. */
export const Verdict = ({ tone, children, detail, actions }: { tone: Tone; children: ReactNode; detail?: ReactNode; actions?: ReactNode }) => (
  <Box className="onc-card" px="md" py="sm">
    <Group justify="space-between" wrap="nowrap" gap="md">
      <Group gap={10} wrap="nowrap" style={{ minWidth: 0 }}>
        <Box w={10} h={10} style={{ flexShrink: 0, borderRadius: 5, background: `var(--mantine-color-${toneColor[tone]}-6)` }} />
        <Stack gap={0} style={{ minWidth: 0 }}>
          <Text fw={600} size="md">
            {children}
          </Text>
          {detail && (
            <Text component="div" size="xs" c="dimmed">
              {detail}
            </Text>
          )}
        </Stack>
      </Group>
      {actions && (
        <Group gap="xs" wrap="nowrap">
          {actions}
        </Group>
      )}
    </Group>
  </Box>
);

/**
 * A Status page: its title (or the path to an item), when it was read, and
 * then everything else, its verdict first. Wider than a settings page, for
 * tables and charts.
 */
export const StatusPage = ({
  title,
  live,
  actions,
  children,
}: {
  title: ReactNode | Crumb[];
  /** "live, read from the devices 4 s ago", or why not. */
  live?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <Stack gap="lg" maw={1080} mx="auto" py="lg" px="md">
    <Box>
      <Group justify="space-between" wrap="nowrap" gap="md">
        <Title order={2} style={{ minWidth: 0 }}>
          {Array.isArray(title) ? <Crumbs crumbs={title} /> : title}
        </Title>
        {actions && (
          <Group gap="xs" wrap="nowrap">
            {actions}
          </Group>
        )}
      </Group>
      {live && (
        <Text c="dimmed" size="sm" mt={4}>
          {live}
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
          <Text span inherit c="dimmed" component="button" type="button" onClick={crumb.onClick} className="onc-crumb">
            {crumb.label}
          </Text>
        ) : (
          crumb.label
        )}
      </span>
    ))}
  </>
);

/** A card with a title, for a chart, a table or facts; its own actions at the right. */
export const Panel = ({
  title,
  actions,
  children,
  padded = true,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** A table fills its card to the edges. */
  padded?: boolean;
}) => (
  <Stack gap={8}>
    {(title || actions) && (
      <Group justify="space-between" px={4} mih={22} wrap="nowrap">
        {title && (
          <Text fw={600} size="sm" className="onc-section-title">
            {title}
          </Text>
        )}
        {actions}
      </Group>
    )}
    <Box className="onc-card" p={padded ? "md" : 0}>
      {children}
    </Box>
  </Stack>
);

/**
 * Edit › beside a live value a setting controls: opens settings at that
 * setting's row (settingUrl, form/landing.ts). Nothing when no page edits it.
 */
export const EditLink = ({ setting, label = "Edit ›" }: { setting: string; label?: string }) => {
  const url = settingUrl(setting);
  return url ? (
    <Anchor component={Link} to={url} size="xs" className="onc-edit" onClick={(e: MouseEvent) => e.stopPropagation()}>
      {label}
    </Anchor>
  ) : null;
};

/** Facts as label above value, in a grid: what a thing is, at a glance; one a setting controls has its Edit › (the third part: its path). */
export const Facts = ({ items, cols = { base: 2, sm: 3 } }: { items: [ReactNode, ReactNode, string?][]; cols?: Record<string, number> }) => (
  <SimpleGrid cols={cols} spacing="md" verticalSpacing="sm">
    {items.map(([label, value, setting], i) => (
      <Stack key={i} gap={2} style={{ minWidth: 0 }}>
        <Group gap={6} wrap="nowrap">
          <Text size="xs" c="dimmed">
            {label}
          </Text>
          {setting && <EditLink setting={setting} />}
        </Group>
        <Text component="div" size="sm" style={{ overflowWrap: "anywhere" }}>
          {value ?? "—"}
        </Text>
      </Stack>
    ))}
  </SimpleGrid>
);

/** A headline figure on a summary card: what, how much, and a line under it; the whole card a link. */
export const SummaryCard = ({
  title,
  tone,
  headline,
  lines = [],
  onOpen,
  children,
}: {
  title: string;
  tone: Tone;
  headline: ReactNode;
  lines?: ReactNode[];
  onOpen?: () => void;
  children?: ReactNode;
}) => (
  <Box
    className={`onc-card${onOpen ? " onc-link-card" : ""}`}
    p="md"
    role={onOpen ? "link" : undefined}
    tabIndex={onOpen ? 0 : undefined}
    onClick={onOpen}
    onKeyDown={(e) => onOpen && (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onOpen())}
    aria-label={onOpen ? `${title}: open` : undefined}
  >
    <Stack gap={4}>
      <Group gap={6} wrap="nowrap">
        <ToneDot tone={tone} />
        <Text size="xs" c="dimmed" fw={500}>
          {title}
        </Text>
      </Group>
      <Text component="div" fz={20} fw={600} lh={1.2}>
        {headline}
      </Text>
      {lines.filter(Boolean).map((line, i) => (
        <Text key={i} component="div" size="xs" c="dimmed" truncate>
          {line}
        </Text>
      ))}
      {children}
    </Stack>
  </Box>
);

/** "−67 dBm", with a true minus. */
export const dbm = (value?: number) => (value === undefined ? "—" : `${value < 0 ? "−" : ""}${Math.abs(Math.round(value))} dBm`);

/** "12 ms", "0.4 ms". */
export const ms = (value?: number) => (value === undefined ? "—" : `${value < 1 ? Math.round(value * 10) / 10 : Math.round(value)} ms`);

/** "866 Mbit/s", "72.2 Mbit/s", "1.2 Gbit/s". */
export const mbit = (value?: number) =>
  value === undefined ? "—" : value >= 1000 ? `${(value / 1000).toFixed(1)} Gbit/s` : `${value >= 100 ? Math.round(value) : Math.round(value * 10) / 10} Mbit/s`;

/** "42%". */
export const percent = (share?: number) => (share === undefined ? "—" : `${Math.round(share * 100)}%`);
