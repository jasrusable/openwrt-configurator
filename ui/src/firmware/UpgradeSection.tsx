// The Firmware tab's upgrade: the devices that would move, in the order they
// would (the router last), what that means for the network, one tick that
// it was understood, and then where each device is while it runs. It saves
// first, as Save and Apply does: the upgrade applies the saved settings once
// the devices are back.
import { Alert, Button, Checkbox, Group, Loader, Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { FirmwareStep } from "../../../src/applyEvents";
import type { FirmwareRow } from "../../../src/firmware/target";
import type { Intent } from "../../../src/intent/schema";
import { seriesOf, uncheckedSeries } from "../../../src/release";
import { useFirmwareRows, useStartUpgrade, useUpdates } from "../data/firmware";
import { UpdateDot } from "../kit/UpdateDot";
import { useProvision } from "../data/provision";
import { useDraftValue } from "../form/draft";
import { useSaveActions } from "../form/IntentForm";
import { Section, SettingRow } from "../kit/layout";

const stepWords: Record<FirmwareStep, string> = {
  building: "Waiting for its image",
  downloading: "Downloading its image",
  checking: "Checking the image",
  flashing: "Flashing",
  rebooting: "Restarting on the new release",
  upgraded: "Upgraded, settings kept",
  failed: "Stopped",
};

const targetOf = (row: FirmwareRow) => (row.target.kind === "release" ? row.target.version : "");

/** Access points first (on the mesh before cabled), the router last: as the run goes. */
const inOrder = (intent: Intent, rows: FirmwareRow[]) => {
  const rank = (name: string) => {
    const d = intent.hardware.find((h) => h.name === name);
    return d?.role === "router" ? 2 : d?.uplink === "mesh" ? 0 : 1;
  };
  return [...rows].sort((a, b) => rank(a.device) - rank(b.device));
};

/** Where each device is in the run, and how it ended. */
const Progress = ({ steps, running, failed, log }: { steps: Record<string, FirmwareStep>; running: boolean; failed: boolean; log: string }) => (
  <Section title="Upgrading" description={running ? "One device at a time; each is offline while it restarts." : undefined}>
    {Object.entries(steps).map(([device, step]) => (
      <SettingRow key={device} label={device}>
        <Group gap={6} wrap="nowrap">
          {running && !["upgraded", "failed"].includes(step) && <Loader size={12} />}
          <Text size="sm" c={step === "failed" ? "red" : step === "upgraded" ? "green" : "dimmed"}>
            {stepWords[step]}
          </Text>
        </Group>
      </SettingRow>
    ))}
    {failed && (
      <Alert color="red" title="The upgrade stopped">
        <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
          {log.trim().split("\n").slice(-3).join("\n")}
        </Text>
      </Alert>
    )}
  </Section>
);

export const UpgradeSection = () => {
  const intent: Intent = useDraftValue();
  const rows = useFirmwareRows();
  const provision = useProvision().data;
  const start = useStartUpgrade();
  const { save } = useSaveActions({ prefetchPlan: false });
  const [understood, setUnderstood] = useState(false);
  const [newSeriesOk, setNewSeriesOk] = useState(false);
  const [downgradeOk, setDowngradeOk] = useState(false);
  const running = provision?.state === "running";
  const updates = useUpdates();
  const steps = provision?.progress.firmware;
  const moving = inOrder(intent, rows.filter((r) => r.state === "update" || r.state === "downgrade"));
  const downgrades = moving.filter((r) => r.state === "downgrade");
  // Into a series this app has not been checked against: ticked on its own.
  const newSeries = [
    ...new Set(moving.flatMap((r) => (r.target.kind === "release" && uncheckedSeries(r.target.version) ? [seriesOf(r.target.version)!] : []))),
  ];
  const progress = steps && Object.keys(steps).length > 0 && (
    <Progress steps={steps} running={running} failed={provision?.state === "failed"} log={provision?.log ?? ""} />
  );
  if (!moving.length) {
    return (
      progress || (
        <Section title="Upgrade">
          <SettingRow label="Nothing to upgrade" description="Every device runs its release, holds, or has not been read yet." />
        </Section>
      )
    );
  }
  const upgrade = async () => {
    // Saved first: the run reads the saved settings, and applies them after.
    if (await save()) {
      start.mutate({
        devices: moving.map((r) => r.device),
        acceptNewSeries: newSeries.length > 0 && newSeriesOk,
        acceptDowngrade: downgrades.length > 0 && downgradeOk,
      });
    }
  };
  return (
    <Stack gap="lg">
      {progress}
      <Section
        title={
          updates ? (
            <Group gap={6} wrap="nowrap" component="span">
              Upgrade <UpdateDot label={updates.text} />
            </Group>
          ) : (
            "Upgrade"
          )
        }
        description="Each device downloads its own image from OpenWrt's build server (built with what its role needs), checks it, and is flashed with its settings kept. One at a time, the router last; each is offline for a few minutes while it restarts. Then your saved settings are applied."
      >
        {moving.map((r) => (
          <SettingRow
            key={r.device}
            label={r.device}
            description={`${r.running} → ${r.target.kind === "release" ? r.target.version : ""}`}
          />
        ))}
        <SettingRow label="Each device is offline for a few minutes while it upgrades">
          <Checkbox
            aria-label="Each device is offline for a few minutes while it upgrades"
            checked={understood}
            onChange={(e) => setUnderstood(e.currentTarget.checked)}
          />
        </SettingRow>
        {downgrades.length > 0 && (
          <SettingRow
            label={downgrades.map((r) => `Downgrade ${r.device} to ${targetOf(r)}`).join(", ")}
            description="Within a series its settings are kept. Back to an older series only its SSH keys are: it restarts on this app's first-boot settings, then everything is applied again for that release."
          >
            <Checkbox
              aria-label={downgrades.map((r) => `Downgrade ${r.device} to ${targetOf(r)}`).join(", ")}
              checked={downgradeOk}
              onChange={(e) => setDowngradeOk(e.currentTarget.checked)}
            />
          </SettingRow>
        )}
        {newSeries.length > 0 && (
          <SettingRow
            label={`New series ${newSeries.join(", ")}: settings carried over, not yet checked by this app`}
            description="OpenWrt may have changed how some settings work; the apply after the upgrade writes them as this app knows them."
          >
            <Checkbox
              aria-label={`New series ${newSeries.join(", ")}: settings carried over, not yet checked by this app`}
              checked={newSeriesOk}
              onChange={(e) => setNewSeriesOk(e.currentTarget.checked)}
            />
          </SettingRow>
        )}
        <SettingRow
          label={`Upgrade ${moving.length} device${moving.length === 1 ? "" : "s"}`}
          {...(start.error ? { error: (start.error as Error).message } : {})}
        >
          <Button
            disabled={!understood || (newSeries.length > 0 && !newSeriesOk) || (downgrades.length > 0 && !downgradeOk) || running}
            loading={start.isPending} onClick={() => void upgrade()}>
            Upgrade
          </Button>
        </SettingRow>
      </Section>
    </Stack>
  );
};
