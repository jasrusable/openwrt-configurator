// A run as it goes: one line per device with the steps every device goes
// through, how long is left to confirm them all, and what happens if this
// page is lost meanwhile. Read from the run's own events (src/applyEvents.ts).
import { Badge, Group, Loader, Text } from "@mantine/core";
import { IconCheck } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { DeviceStep } from "../../../src/applyEvents";
import type { ProvisionInfo } from "../data/api";
import { Section, SettingRow } from "../kit/layout";
import { progressOf } from "./progress";
import { clock, ended, stages, stageStates, timeOfDay } from "./run";

/** The time now, ticking each second while shown. */
const useNow = () => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
};

/** One device's steps: those done ticked, the current one turning, the rest grey; its outcome once it has one. */
export const DeviceSteps = ({ step }: { step: DeviceStep }) => {
  if (ended(step)) {
    const { label, tone } = progressOf[step];
    return (
      <Badge variant="light" color={tone} size="md" radius="sm" style={{ textTransform: "none" }}>
        {label}
      </Badge>
    );
  }
  const states = stageStates(step);
  return (
    <Group gap={10} wrap="wrap" justify="flex-end">
      {stages.map(({ label }, i) => (
        <Group key={label} gap={4} wrap="nowrap">
          {states[i] === "done" ? (
            <IconCheck size={13} color="var(--mantine-color-green-6)" />
          ) : states[i] === "current" ? (
            <Loader size={11} />
          ) : null}
          <Text size="xs" fw={states[i] === "current" ? 600 : 400} c={states[i] === "next" ? "dimmed" : undefined}>
            {label}
          </Text>
        </Group>
      ))}
    </Group>
  );
};

/** What the run promises right now, in words: nothing changed yet; confirming by a time; finishing up. */
const promise = (info: ProvisionInfo, serverNow: number) => {
  const { window, devices } = info.progress;
  const steps = Object.values(devices);
  if (!window) return { label: "Getting ready", detail: "Nothing has changed on your devices yet." };
  const backBy = `If you lose this page, wait: every device is back on its previous settings by ${timeOfDay(window.restoredBy)} at the latest.`;
  if (steps.some((s) => s === "rolling-back" || s === "recovering")) {
    return { label: "Rolling back", detail: `A device could not be reached afterwards, so every device is going back to its previous settings. ${backBy}` };
  }
  if (steps.length > 0 && steps.every((s) => s === "confirmed")) {
    return { label: "Every device has the new settings", detail: "Finishing up." };
  }
  const left = window.confirmBy - serverNow;
  return left > 0
    ? { label: `${clock(left)} left to confirm every device`, detail: backBy }
    : { label: "Confirming…", detail: backBy };
};

export const RunProgress = ({ info, receivedAt }: { info: ProvisionInfo; receivedAt: number }) => {
  const now = useNow();
  // Deadlines are on the server's clock; this browser's may differ.
  const serverNow = now + (info.serverTime - receivedAt);
  const { label, detail } = promise(info, serverNow);
  return (
    <Section title={info.run?.undo ? "Undoing the last apply" : "Applying"}>
      <SettingRow label={label} description={detail}>
        <Loader size="sm" />
      </SettingRow>
      {info.devices.map((name) => (
        <SettingRow key={name} label={name}>
          <DeviceSteps step={info.progress.devices[name] ?? "waiting"} />
        </SettingRow>
      ))}
    </Section>
  );
};
