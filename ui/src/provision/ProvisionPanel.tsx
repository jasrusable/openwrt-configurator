import { Alert, Loader, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconCheck, IconCloudUpload, IconLoader2 } from "@tabler/icons-react";
import type { ProvisionInfo } from "../data/api";
import { useProvision } from "../data/provision";
import { useDraftChanged } from "../form/IntentForm";
import { Section, SettingRow } from "../kit/layout";
import { LogView } from "../kit/LogView";
import { applyStatus, lastRun } from "./status";
import { DeviceChangesSection } from "./UciDiff";

/** Where the devices stand, and how the last run went, in words. */
const Status = ({ info }: { info: ProvisionInfo }) => {
  const status = applyStatus(info);
  const run = info.state === "running" ? undefined : lastRun(info.state);
  return (
    <Section title="Status">
      <SettingRow label={status.title} description={status.detail}>
        <ThemeIcon variant="light" color={status.color} radius="xl" size={26}>
          {status.pending ? <IconCloudUpload size={15} /> : status.color === "blue" ? <IconLoader2 size={15} /> : <IconCheck size={15} />}
        </ThemeIcon>
      </SettingRow>
      {run && <SettingRow label={run.title} />}
    </Section>
  );
};

// What will change; Status already says when it is everything or nothing.
const Changes = ({ info }: { info: ProvisionInfo }) =>
  info.live !== "differs" || info.changes.length === 0 ? null : (
    <Section title="What will change">
      {info.changes.map((change) => (
        <SettingRow
          key={change.path}
          label={change.label.join(" › ")}
          description={change.description}
        >
          <Text size="sm" c="dimmed" ta="right">
            {change.kind === "added"
              ? `Added${change.after ? `: ${change.after}` : ""}`
              : change.kind === "removed"
              ? "Removed"
              : change.before === undefined
              ? "Changed"
              : `${change.before} → ${change.after}`}
          </Text>
        </SettingRow>
      ))}
    </Section>
  );

/** The preview of a provision, the button that starts it, and its progress. */
export const ProvisionPanel = () => {
  const provision = useProvision();
  const unsaved = useDraftChanged();

  if (provision.isError) {
    return (
      <Alert color="red" title="Could not load the apply status">
        {provision.error.message}
      </Alert>
    );
  }
  if (!provision.data) return <Loader m="xl" />;
  const info = provision.data;

  return (
    <Stack gap="xl">
      <Status info={info} />

      {unsaved && (
        <Alert color="orange" title="Unsaved changes">
          Save or revert your changes first: only saved settings are applied.
        </Alert>
      )}

      <Changes info={info} />

      <DeviceChangesSection devices={info.devices} running={info.state === "running"} />

      {info.state !== "idle" && (
        <Section title="Progress">
          <LogView text={info.log} />
        </Section>
      )}
    </Stack>
  );
};
