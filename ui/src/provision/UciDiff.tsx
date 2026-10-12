// What an apply changes on each device, as OpenWrt sees it (src/applyDiff.ts):
// read from the devices while this page is open, a row per device with a
// summary, and its `uci show` lines on request. Secrets show as "(hidden)".
import { Box, Button, Code, Collapse, Text } from "@mantine/core";
import { useState } from "react";
import type { DeviceDiff } from "../../../src/applyDiff";
import { useApplyDiff } from "../data/devices";
import { Section, SettingRow } from "../kit/layout";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "12 settings · 1 package · 2 files", or that nothing changes. */
const summary = (d: Exclude<DeviceDiff, { error: string }>) => {
  const packages = d.packages.added.length + d.packages.removed.length;
  const parts = [
    d.config.length && plural(d.config.length, "setting"),
    packages && plural(packages, "package"),
    d.files.length && plural(d.files.length, "file"),
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "Nothing changes";
};

/** Its changes as lines: + added, − removed, before → after. */
const Lines = ({ diff }: { diff: Exclude<DeviceDiff, { error: string }> }) => {
  const line = (sign: "+" | "−" | "~", text: string, key: string) => (
    <Text
      key={key}
      component="div"
      ff="monospace"
      size="xs"
      c={sign === "+" ? "green" : sign === "−" ? "red" : undefined}
      style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}
    >
      {sign} {text}
    </Text>
  );
  return (
    <Code block p="sm" style={{ background: "var(--onc-page)" }}>
      {diff.config.map((c) =>
        c.before === undefined
          ? line("+", `${c.key}=${c.after}`, c.key)
          : c.after === undefined
          ? line("−", `${c.key}=${c.before}`, c.key)
          : line("~", `${c.key}: ${c.before} → ${c.after}`, c.key)
      )}
      {diff.packages.added.map((p) => line("+", `package ${p}`, `p+${p}`))}
      {diff.packages.removed.map((p) => line("−", `package ${p}`, `p-${p}`))}
      {diff.files.map((f) =>
        line(f.change === "added" ? "+" : f.change === "removed" ? "−" : "~", `file ${f.path}`, `f${f.path}`)
      )}
    </Code>
  );
};

const DeviceChanges = ({ diff }: { diff: DeviceDiff }) => {
  const [open, setOpen] = useState(false);
  if ("error" in diff) return <SettingRow label={diff.hostname} description={`Not reached: ${diff.error}`} />;
  const changes = diff.config.length + diff.packages.added.length + diff.packages.removed.length + diff.files.length;
  return (
    <Box>
      <SettingRow label={diff.hostname} description={summary(diff)}>
        {changes > 0 && (
          <Button variant="subtle" color="gray" size="compact-sm" onClick={() => setOpen((o) => !o)}>
            {open ? "Hide" : "Show"}
          </Button>
        )}
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
export const DeviceChangesSection = ({ devices, running }: { devices: string[]; running: boolean }) => {
  const diff = useApplyDiff(!running);
  return (
    <Section
      title="Devices"
      description="What applying writes on each, as uci shows it. Passwords and keys are hidden."
    >
      {devices.map((name) => {
        const d = diff.data?.find((x) => x.hostname === name);
        return d ? (
          <DeviceChanges key={name} diff={d} />
        ) : (
          <SettingRow key={name} label={name} description={running ? "Being applied…" : diff.isFetching ? "Reading what it has now…" : "Will be reconfigured"} />
        );
      })}
    </Section>
  );
};
