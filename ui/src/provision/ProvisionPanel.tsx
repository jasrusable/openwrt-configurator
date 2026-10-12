import { Alert, Badge, Group, Loader, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { ProvisionInfo } from "../data/api";
import { useProvision, useStartProvision } from "../data/provision";
import { useDraftChanged } from "../form/IntentForm";
import { ConfirmButton } from "../kit/ConfirmButton";
import { Section, SettingRow } from "../kit/layout";
import { LogView } from "../kit/LogView";

const liveBadge: Record<ProvisionInfo["live"], [string, string]> = {
  matches: ["green", "Up to date"],
  differs: ["orange", "Unapplied changes"],
  none: ["gray", "Not applied from here yet"],
};

const runBadge: Partial<Record<ProvisionInfo["state"], [string, string]>> = {
  running: ["blue", "Applying…"],
  succeeded: ["green", "Last run succeeded"],
  failed: ["red", "Last run failed"],
  interrupted: ["red", "Last run was interrupted"],
};

const Changes = ({ info }: { info: ProvisionInfo }) =>
  info.live === "none" ? (
    <Section description="The first apply from here sets up every device from the whole configuration.">
      <SettingRow label="Everything" description="Nothing has been applied from this app yet." />
    </Section>
  ) : info.changes.length === 0 ? (
    <Section>
      <SettingRow label="No changes" description="Your devices already have this configuration." />
    </Section>
  ) : (
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
  const start = useStartProvision();
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
  const running = info.state === "running";
  const [liveColor, liveText] = liveBadge[info.live];
  const run = runBadge[info.state];

  return (
    <Stack gap="lg">
      <Text size="sm" c="dimmed">
        Send your saved settings to your devices. Each device checks it can
        still be reached afterwards, and if any cannot, every device rolls back
        on its own.
      </Text>
      <Group gap="xs">
        <Badge color={liveColor} variant="light">
          {liveText}
        </Badge>
        {run && (
          <Badge color={run[0]} variant="light">
            {run[1]}
          </Badge>
        )}
      </Group>

      {unsaved && (
        <Alert color="orange" title="Unsaved changes">
          Save or revert your changes first: only saved settings are applied.
        </Alert>
      )}

      <Changes info={info} />

      <Section title="Devices">
        {info.devices.map((name) => (
          <SettingRow key={name} label={name} description="Will be reconfigured" />
        ))}
      </Section>

      <Group justify="flex-end">
        <ConfirmButton
          size="md"
          disabled={unsaved || running}
          loading={running || start.isPending}
          title="Apply to your network?"
          message={`This reconfigures ${info.devices.join(
            ", "
          )}. It takes a few minutes, and devices may briefly drop off the network. If any device cannot be reached afterwards, all of them roll back on their own.`}
          confirmLabel="Apply"
          onConfirm={() =>
            start.mutate(undefined, {
              onError: (e) =>
                notifications.show({ message: (e as Error).message, color: "red" }),
            })
          }
        >
          Apply
        </ConfirmButton>
      </Group>

      {info.state !== "idle" && (
        <Section title="Progress">
          <LogView text={info.log} />
        </Section>
      )}
    </Stack>
  );
};
