import { Alert, Loader, Stack, Text, ThemeIcon } from "@mantine/core";
import { IconAlertTriangle, IconCheck, IconCloudUpload, IconLoader2 } from "@tabler/icons-react";
import type { ProvisionInfo } from "../data/api";
import { useProvision } from "../data/provision";
import { useDraftChanged } from "../form/IntentForm";
import { Section, SettingRow } from "../kit/layout";
import { applyStatus } from "./status";
import { DeviceChangesSection } from "./UciDiff";

/** One line on where things stand: the run now, else the last one, else what is pending. */
const summaryOf = (info: ProvisionInfo) => {
  const steps = Object.values(info.progress.devices);
  const rollingBack = steps.some((s) => s === "rolling-back" || s === "rolled-back" || s === "recovering");
  if (info.state === "running") {
    return rollingBack
      ? { title: "Rolling back…", detail: "A device could not be reached afterwards, so every device is going back to its previous settings.", color: "orange", icon: IconLoader2 }
      : { title: "Applying…", detail: "Your devices are being reconfigured. This takes a few minutes.", color: "blue", icon: IconLoader2 };
  }
  if (info.state === "failed") {
    return info.progress.outcome === "rolled-back"
      ? { title: "Not applied", detail: "A device could not be reached afterwards, so every device went back to its previous settings.", color: "red", icon: IconAlertTriangle }
      : { title: "Not applied", detail: "The run stopped before changing anything. Details below.", color: "red", icon: IconAlertTriangle };
  }
  if (info.state === "applied-with-problems") {
    return { title: "Applied, with a problem", detail: "Your devices have the new settings, but a step after it failed. Details below.", color: "orange", icon: IconAlertTriangle };
  }
  const status = applyStatus(info);
  return { title: status.title, detail: status.detail, color: status.color, icon: status.pending ? IconCloudUpload : IconCheck };
};

const Summary = ({ info }: { info: ProvisionInfo }) => {
  const { title, detail, color, icon: Icon } = summaryOf(info);
  return (
    <Section>
      <SettingRow label={title} description={detail}>
        <ThemeIcon variant="light" color={color} radius="xl" size={26}>
          <Icon size={15} />
        </ThemeIcon>
      </SettingRow>
    </Section>
  );
};

// What will change; Status already says when it is everything or nothing.
const Changes = ({ info }: { info: ProvisionInfo }) =>
  info.live !== "differs" || info.changes.length === 0 ? null : (
    <Section title="What will change">
      {info.changes.map((change, i) => (
        <SettingRow
          // A path can come twice (one item removed and another added where it was).
          key={`${change.kind}:${change.path}:${i}`}
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
      <Summary info={info} />

      {unsaved && (
        <Alert color="orange" title="Unsaved changes">
          Save or revert your changes first: only saved settings are applied.
        </Alert>
      )}

      <Changes info={info} />

      <DeviceChangesSection
        devices={info.devices}
        running={info.state === "running"}
        steps={info.state === "idle" ? undefined : info.progress.devices}
      />
    </Stack>
  );
};
