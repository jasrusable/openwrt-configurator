// What an apply changes on each device, as OpenWrt sees it (src/applyDiff.ts):
// read from the devices while this page is open, a row per device with a
// summary, and its `uci show` lines on request. Secrets show as "(hidden)".
import { Badge, Box, Button, Code, Collapse, Group, Text } from "@mantine/core";
import { useState } from "react";
import type { DeviceDiff } from "../../../src/applyDiff";
import { useApplyDiff } from "../data/devices";
import type { DeviceStep } from "../../../src/applyEvents";
import { Progress, progressOf } from "./progress";
import { Section, SettingRow } from "../kit/layout";
import { ago } from "../facts";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "12 settings · 3 renamed · 1 package · 2 files", or that nothing changes. */
const summary = (d: Exclude<DeviceDiff, { error: string }>) => {
  const packages = d.packages.added.length + d.packages.removed.length;
  const renamed = d.config.filter((c) => c.renamedFrom).length;
  const settings = d.config.length - renamed;
  const parts = [
    settings && plural(settings, "setting"),
    renamed && `${renamed} renamed`,
    packages && plural(packages, "package"),
    d.files.length && plural(d.files.length, "file"),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing changes";
};

/** Its changes as lines: + added, − removed, before → after, renamed; a fix's, said so. */
const Lines = ({ diff }: { diff: Exclude<DeviceDiff, { error: string }> }) => {
  const line = (sign: "+" | "−" | "~", text: string, key: string, fix?: string) => (
    <Text
      key={key}
      component="div"
      ff="monospace"
      size="xs"
      c={sign === "+" ? "green" : sign === "−" ? "red" : undefined}
      style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
    >
      {sign} {text}
      {fix && (
        <Text span c="dimmed" ff="text" size="xs">
          {"  "}from fix “{fix}”
        </Text>
      )}
    </Text>
  );
  return (
    <Code block p="sm" style={{ background: "var(--onc-page)" }}>
      {diff.config.map((c) =>
        c.renamedFrom
          ? line("~", `${c.renamedFrom} renamed ${c.key.slice(c.key.indexOf(".") + 1)}`, `r${c.key}`)
          : c.before === undefined
          ? line("+", `${c.key}=${c.after}`, c.key, c.fix)
          : c.after === undefined
          ? line("−", `${c.key}=${c.before}`, c.key, c.fix)
          : line("~", `${c.key}: ${c.before} → ${c.after}`, c.key, c.fix)
      )}
      {diff.packages.added.map((p) => line("+", `package ${p}`, `p+${p}`, diff.packages.fixes?.[p]))}
      {diff.packages.removed.map((p) => line("−", `package ${p}`, `p-${p}`, diff.packages.fixes?.[p]))}
      {diff.files.map((f) =>
        line(f.change === "added" ? "+" : f.change === "removed" ? "−" : "~", `file ${f.path}`, `f${f.path}`, f.fix)
      )}
    </Code>
  );
};

/** Where the device is in a run, beside its changes. */
const ProgressBadge = ({ progress }: { progress?: Progress }) =>
  progress ? (
    <Badge variant="light" color={progress.tone} size="md" radius="sm" style={{ textTransform: "none" }}>
      {progress.label}
    </Badge>
  ) : null;

const DeviceChanges = ({ diff, progress }: { diff: DeviceDiff; progress?: Progress }) => {
  const [open, setOpen] = useState(false);
  if ("error" in diff) {
    return (
      <SettingRow label={diff.hostname} description={`Not reached: ${diff.error}`}>
        <ProgressBadge progress={progress} />
      </SettingRow>
    );
  }
  const changes = diff.config.length + diff.packages.added.length + diff.packages.removed.length + diff.files.length;
  return (
    <Box>
      <SettingRow label={diff.hostname} description={summary(diff)}>
        <Group gap="xs" wrap="nowrap">
          <ProgressBadge progress={progress} />
          {changes > 0 && (
            <Button variant="subtle" color="gray" size="compact-sm" onClick={() => setOpen((o) => !o)}>
              {open ? "Hide" : "Show"}
            </Button>
          )}
        </Group>
      </SettingRow>
      <Collapse expanded={open}>
        <Box px="md" pb="md">
          <Lines diff={diff} />
        </Box>
      </Collapse>
    </Box>
  );
};

/**
 * Every device the apply reconfigures, with what changes on it; the uci lines
 * on request, for people who know OpenWrt.
 */
export const DeviceChangesSection = ({
  devices,
  running,
  steps,
}: {
  devices: string[];
  running: boolean;
  /** During and after a run: where each device got to, as the run reported. */
  steps?: Partial<Record<string, DeviceStep>>;
}) => {
  const diff = useApplyDiff(!running);
  const progress = Object.fromEntries(
    devices.map((name) => [name, steps ? progressOf[steps[name] ?? "waiting"] : undefined])
  );
  return (
    <Section
      title="Devices"
      description={
        diff.isFetching && diff.data
          ? "What applying writes on each, as uci shows it; checking the devices again…"
          : diff.isError
            ? `What each holds now could not be read: ${(diff.error as Error).message}`
            : `What applying writes on each, as uci shows it${
                // Possibly kept in this browser from an earlier read (data/persist.ts).
                diff.data ? `, read from the devices ${ago(diff.dataUpdatedAt)}` : ""
              }. Passwords and keys are hidden.`
      }
    >
      {devices.map((name) => {
        const d = diff.data?.find((x) => x.hostname === name);
        return d ? (
          <DeviceChanges key={name} diff={d} progress={progress[name]} />
        ) : (
          <SettingRow
            key={name}
            label={name}
            description={
              running
                ? "Being applied"
                : diff.isFetching
                  ? "Reading what it has now…"
                  : diff.isError
                    ? "What it holds now could not be read, so neither can what changes"
                    : "Will be reconfigured"
            }
          >
            <ProgressBadge progress={progress[name]} />
          </SettingRow>
        );
      })}
    </Section>
  );
};
