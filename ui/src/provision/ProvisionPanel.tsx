import { Alert, Button, Loader, Stack, Text, ThemeIcon } from "@mantine/core";
import { ReactNode, useState } from "react";
import { IconAlertTriangle, IconCheck, IconCloudUpload, IconLoader2 } from "@tabler/icons-react";
import type { ProvisionInfo } from "../data/api";
import { useProvision } from "../data/provision";
import { useDraftChanged } from "../form/IntentForm";
import { Section, SettingRow } from "../kit/layout";
import { LogView } from "../kit/LogView";
import { applyStatus } from "./status";
import { DeviceChangesSection } from "./UciDiff";

/** Hidden until asked for. */
const Details = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(false);
  return (
    <Stack gap="md">
      <Button variant="subtle" color="gray" size="xs" w="fit-content" onClick={() => setOpen(!open)}>
        {open ? "Hide details" : "Details"}
      </Button>
      {open && children}
    </Stack>
  );
};

/** One line on where things stand: the run now, else the last one, else what is pending. */
const summaryOf = (info: ProvisionInfo) => {
  const log = info.log ?? "";
  const rolledBack = /rolled back|rolling back/i.test(log);
  if (info.state === "running") {
    return rolledBack
      ? { title: "Rolling back…", detail: "A device could not be reached afterwards, so every device is going back to its previous settings.", color: "orange", icon: IconLoader2 }
      : { title: "Applying…", detail: "Your devices are being reconfigured. This takes a few minutes.", color: "blue", icon: IconLoader2 };
  }
  if (info.state === "failed") {
    return rolledBack
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
      <Summary info={info} />

      {unsaved && (
        <Alert color="orange" title="Unsaved changes">
          Save or revert your changes first: only saved settings are applied.
        </Alert>
      )}

      <Changes info={info} />

      {/* For people who know OpenWrt: what each device gets, and the run's log. */}
      <Details>
        <DeviceChangesSection devices={info.devices} running={info.state === "running"} />
        {info.state !== "idle" && (
          <Section title="Log">
            <LogView text={info.log} />
          </Section>
        )}
      </Details>
    </Stack>
  );
};
