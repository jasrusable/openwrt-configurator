// The Firmware tab's upgrade: the devices that would move, in the order they
// would (the router last), what that means for the network, one tick that
// it was understood, and then where each device is while it runs. The
// upgrade applies the saved settings once the devices are back, so nothing
// unreviewed may be among them: other edits saved or discarded and applied
// first; only the firmware choices, which reach no device's config, are
// saved with it. A downgrade or new-series tick is for exactly the devices
// and releases it names: any other is ticked again.
import { Alert, Anchor, Button, Checkbox, Group, Loader, Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { FirmwareStep } from "../../../src/applyEvents";
import { acknowledgementsOf, inFlashOrder, isFirmwareChoice, movingRows, type FirmwareRow } from "../../../src/firmware/target";
import type { Intent } from "../../../src/intent/schema";
import { useFirmwareRows, useStartUpgrade, useUpdates } from "../data/firmware";
import { UpdateDot } from "../kit/UpdateDot";
import { Because } from "../form/fields/binding";
import { missingKey } from "../../../src/firmware/firstBoot";
import { where } from "../../../src/intent/places";
import { Link } from "react-router";
import { useProvision } from "../data/provision";
import { useDraftValue } from "../form/draft";
import { useOwnKey } from "../data/admin";
import { useSaveActions } from "../form/IntentForm";
import { useDraftChanges } from "../provision/pending";
import { Section, SettingRow } from "../kit/layout";

const stepWords: Record<FirmwareStep, string> = {
  building: "Waiting for its image",
  downloading: "Downloading its image",
  checking: "Checking the image",
  flashing: "Flashing",
  rebooting: "Restarting on the new release",
  upgraded: "Upgraded",
  failed: "Stopped",
};

const targetOf = (row: FirmwareRow) => (row.target.kind === "release" ? row.target.version : "");

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
  // What each tick acknowledged, as it was when ticked.
  const [newSeriesOk, setNewSeriesOk] = useState<string>();
  const [downgradeOk, setDowngradeOk] = useState<string>();
  const [unappliedOk, setUnappliedOk] = useState(false);
  const running = provision?.state === "running";
  const updates = useUpdates();
  // No image without this app's key authorized: a device fresh from one lets in only those keys (src/firmware/firstBoot.ts).
  const ownKey = useOwnKey();
  const noKey = ownKey.isSuccess ? missingKey(intent, ownKey.data ?? undefined) : undefined;
  const steps = provision?.progress.firmware;
  // As the run goes: access points first (on the mesh before cabled), the router last.
  const moving = inFlashOrder(intent, movingRows(rows), (r) => r.device);
  const downgrades = moving.filter((r) => r.state === "downgrade");
  const needed = acknowledgementsOf(moving);
  const downgradesKey = JSON.stringify(needed.downgrades);
  const newSeriesKey = needed.newSeries.join(",");
  const { newSeries } = needed;
  // Nothing unreviewed goes out with the apply after: edits beyond the firmware choices are applied first.
  const unsaved = useDraftChanges().filter((c) => !isFirmwareChoice(c.path));
  const unapplied = provision?.live === "differs" ? provision.changes.filter((c) => !isFirmwareChoice(c.path)) : [];
  const neverApplied = provision?.live === "none";
  const blocked = unsaved.length
    ? `Other edits are not saved (${unsaved.map((c) => c.label.join(" › ")).join("; ")}): the settings applied after the upgrade must be ones already applied. Discard them, or save and apply them first.`
    : unapplied.length
      ? `Saved changes are not applied yet (${unapplied.map((c) => c.label.join(" › ")).join("; ")}): apply them first, reviewed, then upgrade.`
      : undefined;
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
    // Firmware choices not saved yet are saved first: the run reads the saved settings.
    if (await save()) {
      start.mutate({ devices: moving.map((r) => r.device), acknowledged: { ...needed, unapplied: neverApplied && unappliedOk } });
    }
  };
  const acknowledged =
    understood &&
    (!newSeries.length || newSeriesOk === newSeriesKey) &&
    (!downgrades.length || downgradeOk === downgradesKey) &&
    (!neverApplied || unappliedOk);
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
        description="Each device downloads its own image from OpenWrt's build server (built with what its role needs), checks it, and is flashed with its settings kept. One at a time, the router last; each is offline for a few minutes while it restarts. Then your saved settings are applied again: nothing may be among them that is not applied yet but these firmware choices, so nothing goes out unreviewed."
      >
        {noKey && (
          <SettingRow label="This app's SSH key must be authorized first" description={noKey}>
            <Anchor component={Link} to="/system" size="sm">
              {where("general", "Authorized keys")}
            </Anchor>
          </SettingRow>
        )}
        {blocked && <SettingRow label="Your other changes first" description={blocked} />}
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
              checked={downgradeOk === downgradesKey}
              onChange={(e) => setDowngradeOk(e.currentTarget.checked ? downgradesKey : undefined)}
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
              checked={newSeriesOk === newSeriesKey}
              onChange={(e) => setNewSeriesOk(e.currentTarget.checked ? newSeriesKey : undefined)}
            />
          </SettingRow>
        )}
        {neverApplied && (
          <SettingRow
            label="Nothing has been applied from here yet: the whole saved configuration is applied after the upgrade, unreviewed"
            description="Apply it first to review what it changes on each device; or tick this to have it applied once the devices are back."
          >
            <Checkbox
              aria-label="Nothing has been applied from here yet: the whole saved configuration is applied after the upgrade, unreviewed"
              checked={unappliedOk}
              onChange={(e) => setUnappliedOk(e.currentTarget.checked)}
            />
          </SettingRow>
        )}
        <SettingRow
          label={`Upgrade ${moving.length} device${moving.length === 1 ? "" : "s"}`}
          {...(start.error ? { error: (start.error as Error).message } : {})}
        >
          <Because reason={noKey ?? blocked}>
            <Button
              disabled={!!noKey || !!blocked || !acknowledged || running}
              loading={start.isPending}
              onClick={() => void upgrade()}
            >
              Upgrade
            </Button>
          </Because>
        </SettingRow>
      </Section>
    </Stack>
  );
};
