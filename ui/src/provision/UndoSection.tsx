// Undo the last apply (only the last): the settings that were live before
// it, applied again with the same checks and rollback as any apply. Shows what it puts back
// first; the saved settings change only when asked.
import { Alert, Button, Group, Switch, Text } from "@mantine/core";
import { IconArrowBackUp } from "@tabler/icons-react";
import { useState } from "react";
import type { ProvisionInfo } from "../data/api";
import { useUndoApply } from "../data/provision";
import { Section, SettingRow } from "../kit/layout";
import { ChangeRows } from "./ChangeRows";
import { timeOfDay } from "./run";

export const UndoSection = ({ info }: { info: ProvisionInfo }) => {
  const undo = useUndoApply();
  const [open, setOpen] = useState(false);
  const [restore, setRestore] = useState(false);
  if (!info.previous || info.state === "running") return null;
  const { appliedAt, changes } = info.previous;
  const day = appliedAt && new Date(appliedAt).toDateString() !== new Date().toDateString() ? ` on ${new Date(appliedAt).toLocaleDateString()}` : "";
  const from = appliedAt ? `the settings applied at ${timeOfDay(appliedAt)}${day}` : "the settings from before the last apply";
  return (
    <Section title="Undo last apply">
      <SettingRow label={`Put back ${from}`} description="Applies them to every device again, with the same checks and rollback as any apply.">
        <Button variant="default" size="xs" leftSection={<IconArrowBackUp size={14} />} onClick={() => setOpen((o) => !o)}>
          {open ? "Cancel" : "Undo…"}
        </Button>
      </SettingRow>
      {open && (
        <>
          {changes.length ? (
            <ChangeRows changes={changes} />
          ) : (
            <SettingRow label="Nothing in your settings changes back">
              <Text size="sm" c="dimmed">
                Applied again as they are
              </Text>
            </SettingRow>
          )}
          <SettingRow
            label="Also make them my saved settings"
            description="Otherwise your saved settings stay as they are, and show as changes to apply."
          >
            <Switch checked={restore} onChange={(e) => setRestore(e.currentTarget.checked)} />
          </SettingRow>
          {undo.error && (
            <Alert color="red" title="Could not undo" m="sm">
              {(undo.error as Error).message}
            </Alert>
          )}
          <Group justify="flex-end" p="sm">
            <Button color="orange" loading={undo.isPending} onClick={() => undo.mutate(restore, { onSuccess: () => setOpen(false) })}>
              Undo last apply
            </Button>
          </Group>
        </>
      )}
    </Section>
  );
};
