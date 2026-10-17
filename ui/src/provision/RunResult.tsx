// How the last run ended, kept in view until the next: what it applied, how
// each device came out and how long it took, with a way to the Activity log.
import { Anchor, Text, ThemeIcon } from "@mantine/core";
import { IconAlertTriangle, IconCheck } from "@tabler/icons-react";
import type { ProvisionInfo } from "../data/api";
import { Section, SettingRow } from "../kit/layout";
import { ChangeRows } from "./ChangeRows";
import { DeviceSteps } from "./RunProgress";
import { duration, timeOfDay } from "./run";

/** How many changes to list before "and N more". */
const shownChanges = 8;

/** Which devices kept a partial run's change, in words. */
const keptWords = (kept: string[] = []) => (kept.length ? kept.join(", ") : "Some devices");

/** The run's ending, in words. */
const verdict = (info: ProvisionInfo) => {
  switch (info.state) {
    case "succeeded":
      return {
        title: info.run?.undo ? "Undone" : "Applied",
        detail: info.run?.undo ? "Every device has the settings from before the last apply again." : "Every device has the new settings.",
        ok: true,
      };
    case "applied-with-problems":
      return { title: "Applied, with a problem", detail: "Your devices have the new settings, but a step after it failed. The log has the details.", ok: false };
    case "failed":
      switch (info.progress.outcome) {
        case "rolled-back":
          return { title: "Not applied", detail: "A device could not be reached afterwards, so every device went back to its previous settings.", ok: false };
        case "partial":
          return {
            title: "Applied on some devices",
            detail: `${keptWords(info.progress.kept)} kept the new settings; the others have their previous ones. Apply again to finish.`,
            ok: false,
          };
        default:
          return { title: "Not applied", detail: "The run stopped before changing anything.", ok: false };
      }
    case "interrupted":
      return {
        title: "Stopped before it finished",
        detail:
          "The apply was stopped, or what ran it restarted, before it could say how it ended. A device it had changed and not confirmed goes back to its previous settings by itself. Apply again to finish.",
        ok: false,
      };
    default:
      return undefined;
  }
};

export const RunResult = ({ info }: { info: ProvisionInfo }) => {
  const shown = verdict(info);
  if (!shown) return null;
  const { startedAt, endedAt, times = {}, devices } = info.progress;
  const when = [
    endedAt && `at ${timeOfDay(endedAt)}`,
    startedAt && endedAt && `took ${duration(endedAt - startedAt)}`,
  ].filter(Boolean);
  const changes = info.state === "succeeded" || info.state === "applied-with-problems" ? info.run?.changes ?? [] : [];
  return (
    <Section
      title="Last apply"
      description={
        <>
          Everything the devices said is in{" "}
          <Anchor href="#/activity" size="xs">
            Activity
          </Anchor>
          .
        </>
      }
    >
      <SettingRow label={[shown.title, ...when].join(" · ")} description={shown.detail}>
        <ThemeIcon variant="light" color={shown.ok ? "green" : "orange"} radius="xl" size={26}>
          {shown.ok ? <IconCheck size={15} /> : <IconAlertTriangle size={15} />}
        </ThemeIcon>
      </SettingRow>
      {info.devices
        .filter((name) => devices[name])
        .map((name) => (
          <SettingRow key={name} label={name} description={times[name] ? duration(times[name].to - times[name].from) : undefined}>
            <DeviceSteps step={devices[name]} />
          </SettingRow>
        ))}
      <ChangeRows changes={changes.slice(0, shownChanges)} />
      {changes.length > shownChanges && (
        <SettingRow label={`and ${changes.length - shownChanges} more`}>
          <Text size="sm" c="dimmed" />
        </SettingRow>
      )}
    </Section>
  );
};
