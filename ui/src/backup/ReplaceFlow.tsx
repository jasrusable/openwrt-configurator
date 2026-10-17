// Putting something in place of the saved settings, as a guided flow in a
// sheet: a backup file (chosen first) or the defaults. The server reviews it
// (src/backup.ts): why it cannot be written, else what it changes, in the
// rows Save and Apply uses. Only Confirm writes it, and only over the saved
// file reviewed (one changed since is read and reviewed again); nothing is
// applied.
import { Alert, Button, FileButton, Group, Loader, Modal, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { BackupReview, BackupSource } from "../../../src/backup";
import { where } from "../../../src/intent/places";
import type { Intent } from "../../../src/intent/schema";
import { RestoreError, restoreBackup, reviewBackup } from "../data/api";
import { intentKey } from "../data/intent";
import { provisionKey } from "../data/provision";
import { Section } from "../kit/layout";
import { ChangeRows } from "../provision/ChangeRows";

export type Replacement = "file" | "defaults";

const words = {
  file: { title: "Restore from a backup", confirm: "Restore", changes: "What restoring changes", refused: "This cannot be restored", failed: "Not restored" },
  defaults: { title: "Reset to defaults", confirm: "Reset", changes: "What resetting changes", refused: "These settings cannot be reset", failed: "Not reset" },
} as const;

/** What the review says: why it cannot be written, else what to know first and what changes. */
const Findings = ({ review, kind, unsaved, firstRun }: { review: BackupReview; kind: Replacement; unsaved: boolean; firstRun: boolean }) =>
  review.issues.length ? (
    <Alert color="red" title={words[kind].refused}>
      <Stack gap={4}>
        {review.issues.map((issue) => (
          <Text key={`${issue.path}:${issue.message}`} size="sm">
            {issue.path ? `${issue.path}: ` : ""}
            {issue.message}
          </Text>
        ))}
      </Stack>
    </Alert>
  ) : (
    <Stack gap="md">
      {review.otherNetwork !== undefined && (
        <Alert color="orange" title="A backup of another network">
          It is of “{review.otherNetwork}”. Restoring it replaces this network's settings with that one's.
        </Alert>
      )}
      {review.upgradedFrom !== undefined && (
        <Alert color="blue">This backup is from an older version of the app: it was upgraded from format {review.upgradedFrom}.</Alert>
      )}
      {unsaved && <Alert color="yellow">Your unsaved edits are discarded.</Alert>}
      {!firstRun &&
        (review.changes.length ? (
          <Section title={words[kind].changes} description="Passwords and keys are hidden.">
            <ChangeRows changes={review.changes} />
          </Section>
        ) : (
          <Text size="sm">Nothing changes: it matches the saved settings.</Text>
        ))}
      <Text size="sm" c="dimmed">
        Nothing reaches your devices until you Save and Apply.
        {firstRun ? "" : " The settings it replaces are kept beside the file, as a .bak (the last five)."}
      </Text>
    </Stack>
  );

export const ReplaceFlow = ({
  kind,
  opened,
  onClose,
  onDone,
  unsaved = false,
  firstRun = false,
}: {
  kind: Replacement;
  opened: boolean;
  onClose: () => void;
  /** The settings as now saved. */
  onDone: (intent: Intent) => void;
  /** The page holds edits not saved, which the new settings replace. */
  unsaved?: boolean;
  /** Nothing is saved yet: no changes to list. */
  firstRun?: boolean;
}) => {
  const phone = useMediaQuery("(max-width: 48em)");
  const queryClient = useQueryClient();
  const [source, setSource] = useState<BackupSource | undefined>(kind === "defaults" ? { from: "defaults" } : undefined);
  const review = useMutation({ mutationFn: () => reviewBackup(source!) });
  const restore = useMutation({
    // Over the saved file the review was of, and no other.
    mutationFn: () => restoreBackup(source!, review.data?.version),
    // Changed elsewhere since: read it again, and review again over it.
    onError: (error) => {
      if (!(error instanceof RestoreError && error.changedElsewhere)) return;
      void queryClient.invalidateQueries({ queryKey: intentKey });
      review.mutate();
    },
    onSuccess: (intent) => {
      onDone(intent);
      queryClient.setQueryData(intentKey, intent);
      void queryClient.invalidateQueries({ queryKey: provisionKey });
      onClose();
    },
  });
  // Each time it opens, from the start: no file, no review.
  useEffect(() => {
    if (!opened) return;
    setSource(kind === "defaults" ? { from: "defaults" } : undefined);
    review.reset();
    restore.reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, kind]);
  // Reviewed again whenever what is asked changes.
  useEffect(() => {
    if (opened && source) review.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, source]);

  const chooseFile = async (file: File | null) => {
    if (!file) return;
    setSource({ from: "file", text: await file.text() });
  };
  const result = review.data?.review;
  const ready = !!result && !result.issues.length && !review.isPending;
  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={<Text fw={600}>{words[kind].title}</Text>}
      size="lg"
      radius="md"
      transitionProps={{ duration: 120 }}
      fullScreen={phone}
    >
      <Stack gap="lg">
        {kind === "file" && (
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm" c={source ? undefined : "dimmed"}>
              {source ? "A backup is chosen." : `Choose a settings file downloaded from ${where("backup")}.`}
            </Text>
            <FileButton onChange={(file) => void chooseFile(file)} accept="application/json,.json">
              {(props) => (
                <Button variant={source ? "default" : "filled"} {...props}>
                  {source ? "Choose another" : "Choose a file…"}
                </Button>
              )}
            </FileButton>
          </Group>
        )}
        {review.isPending && (
          <Group gap="sm">
            <Loader size="sm" />
            <Text size="sm" c="dimmed">
              Checking…
            </Text>
          </Group>
        )}
        {review.isError && (
          <Alert color="red" title={words[kind].refused}>
            {review.error.message}
          </Alert>
        )}
        {result && !review.isPending && (
          <Findings review={result} kind={kind} unsaved={unsaved} firstRun={firstRun} />
        )}
        {restore.isError && (
          <Alert color="red" title={words[kind].failed}>
            {restore.error.message}
          </Alert>
        )}
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button color={kind === "defaults" ? "red" : undefined} disabled={!ready} loading={restore.isPending} onClick={() => restore.mutate()}>
            {words[kind].confirm}
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
};
