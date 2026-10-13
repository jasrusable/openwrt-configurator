// System › Backup: the settings file downloaded as stored; replaced by a
// backup or by the defaults, each through its review (backup/ReplaceFlow.tsx).
import { Alert, Button } from "@mantine/core";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { placeName } from "../../../src/intent/places";
import { downloadBackup } from "../data/api";
import { ReplaceFlow, Replacement } from "../backup/ReplaceFlow";
import { useDraft, useDraftChanged } from "../form/draft";
import { Section, SettingRow, SettingsPage } from "../kit/layout";

export const BackupPage = () => {
  const draft = useDraft();
  const unsaved = useDraftChanged();
  const download = useMutation({ mutationFn: downloadBackup });
  const [replacing, setReplacing] = useState<Replacement>();
  return (
    <SettingsPage title={placeName("backup")} description="Keep a copy of your settings, restore one, or start over.">
      <Section>
        <SettingRow
          label="Download settings"
          description="The settings file as saved, as plain JSON. Passwords and Wi-Fi keys written in it are included as plain text: keep it somewhere safe."
        >
          <Button variant="light" loading={download.isPending} onClick={() => download.mutate()}>
            Download
          </Button>
        </SettingRow>
      </Section>
      {download.isError && <Alert color="red">{download.error.message}</Alert>}
      <Section>
        <SettingRow label="Restore from a backup" description="Replace these settings with a downloaded file, after reviewing what it changes.">
          <Button variant="default" onClick={() => setReplacing("file")}>
            Restore…
          </Button>
        </SettingRow>
        <SettingRow
          label="Reset to defaults"
          description="Start over, keeping the network's name, devices, main network's addresses, mesh, and this app's login and keys."
        >
          <Button variant="default" color="red" onClick={() => setReplacing("defaults")}>
            Reset…
          </Button>
        </SettingRow>
      </Section>
      {replacing && (
        <ReplaceFlow
          kind={replacing}
          opened
          unsaved={unsaved}
          onClose={() => setReplacing(undefined)}
          // The draft starts again from what is now saved: unsaved edits go, as the review said.
          onDone={(intent) => draft.reset(intent)}
        />
      )}
    </SettingsPage>
  );
};
