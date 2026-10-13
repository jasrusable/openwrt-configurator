// One change as a row, wherever changes are listed: the review's plan items
// (src/applyPlan.ts), a run's result and Undo (edits in the settings, as
// items without lines). A row with uci lines opens onto them, grouped by
// device and config. Secrets show as "(hidden)".
import { Badge, Box, Code, Collapse, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { ReactNode, useId, useState } from "react";
import { DeviceLines, editItem, PlanItem, PlanSource, sourceTags } from "../../../src/applyPlan";
import type { Change } from "../../../src/intent/diff";
import { SettingRow } from "../kit/layout";

const tagColors: Record<PlanSource, string> = {
  first: "gray",
  edit: "blue",
  fix: "grape",
  update: "teal",
  drift: "orange",
  unknown: "yellow",
};

export const SourceTag = ({ source }: { source: PlanSource }) => (
  <Badge variant="light" color={tagColors[source]} size="sm" radius="sm" style={{ textTransform: "none", flexShrink: 0 }}>
    {sourceTags[source]}
  </Badge>
);

/** uci lines: by device where there are several, then a group per config with its count. */
export const Lines = ({ lines }: { lines: DeviceLines[] }) => (
  <Code block p="sm" style={{ background: "var(--onc-page)" }}>
    <Stack gap="xs">
      {lines.map(({ device, groups }) => (
        <Stack key={device} gap="xs">
          {lines.length > 1 && (
            <Text size="xs" fw={600} ff="text">
              {device}
            </Text>
          )}
          {groups.map((group) => (
            <Box key={group.title}>
              <Text size="xs" c="dimmed" ff="text">
                {group.title} · {group.lines.length}
              </Text>
              {group.lines.map((line, i) => (
                <Text
                  key={i}
                  component="div"
                  ff="monospace"
                  size="xs"
                  c={line.sign === "+" ? "green" : line.sign === "−" ? "red" : undefined}
                  style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {line.sign} {line.text}
                </Text>
              ))}
            </Box>
          ))}
        </Stack>
      ))}
    </Stack>
  </Code>
);

/** A row that opens onto more below it. */
export const ExpandRow = ({
  label,
  description,
  right,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) => {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <Box>
      <UnstyledButton
        className="onc-device-row"
        w="100%"
        px="md"
        py={10}
        mih={52}
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpen((o) => !o)}
      >
        <Group justify="space-between" gap="sm" wrap="nowrap" align="center">
          <Group gap={8} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
            <IconChevronRight
              size={16}
              aria-hidden
              color="var(--onc-label-2)"
              style={{ flexShrink: 0, transform: open ? "rotate(90deg)" : undefined, transition: "transform 120ms ease" }}
            />
            <Box style={{ minWidth: 0, textAlign: "left" }}>
              <Text size="sm" component="div">
                {label}
              </Text>
              {description && (
                <Text size="xs" c="dimmed" component="div">
                  {description}
                </Text>
              )}
            </Box>
          </Group>
          {right}
        </Group>
      </UnstyledButton>
      <Collapse expanded={open} id={bodyId}>
        <Box px="md" pb="md">
          {children}
        </Box>
      </Collapse>
    </Box>
  );
};

type Row = Pick<PlanItem, "id" | "source" | "title" | "why" | "change"> & Partial<Pick<PlanItem, "devices" | "effect" | "lines">>;

/** One change: its title (and tag, where sources are mixed), why and what is noticed; its lines on request. */
export const ChangeRow = ({ item, tagged = false, note }: { item: Row; tagged?: boolean; note?: string }) => {
  const label = (
    <Group gap={6} wrap="wrap">
      <span>{item.title}</span>
      {tagged && <SourceTag source={item.source} />}
    </Group>
  );
  const description = [item.why, note, ...(item.effect?.notices ?? [])].filter(Boolean).map((line) => <div key={line}>{line}</div>);
  const right = (
    <Text size="sm" c="dimmed" ta="right">
      {item.change ?? item.devices?.join(", ")}
    </Text>
  );
  return item.lines?.length ? (
    <ExpandRow label={label} description={description.length ? description : undefined} right={right}>
      <Lines lines={item.lines} />
    </ExpandRow>
  ) : (
    <SettingRow label={label} description={description.length ? description : undefined}>
      {right}
    </SettingRow>
  );
};

/** Edits in the settings, as rows: a run's changes, or what Undo puts back. */
export const ChangeRows = ({ changes }: { changes: Change[] }) => (
  <>
    {changes.map((change, i) => (
      <ChangeRow key={`${change.kind}:${change.path}:${i}`} item={editItem(change, i)} />
    ))}
  </>
);
