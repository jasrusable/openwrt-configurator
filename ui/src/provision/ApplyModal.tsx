// Save and Apply, as LuCI does it: a sheet over the page you are on, opened
// by the header button, in three states, each replacing the last: the review
// (the change plan, src/applyPlan.ts), the run as it goes, and how it ended
// with Undo. Open while the URL says "?apply", so a reload during a run
// (minutes) opens it again; closing it leaves a run going. Starting sends the
// plan's state hashes: a device changed since stops the run before anything
// is armed, and the review comes back, read again.
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconCloudUpload } from "@tabler/icons-react";
import { useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import { useApplyPlan } from "../data/devices";
import { useProvision, useStartProvision } from "../data/provision";
import { useSaveActions } from "../form/IntentForm";
import { useDraftChanges } from "./pending";
import { readyToApply, Review } from "./Review";
import { RunProgress } from "./RunProgress";
import { RunResult } from "./RunResult";
import { UndoSection } from "./UndoSection";

/** How long after a run ends opening the sheet shows how it ended, rather than the review. */
const resultShownMs = 10 * 60_000;

/** Whether the Apply sheet is open, and the ways to open and close it. */
export const useApplySheet = () => {
  const [params, setParams] = useSearchParams();
  const set = (open: boolean) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (open) next.set("apply", "");
        else next.delete("apply");
        return next;
      },
      { replace: !open }
    );
  return { opened: params.has("apply"), open: () => set(true), close: () => set(false) };
};

export const ApplyModal = () => {
  const sheet = useApplySheet();
  // Full screen on a phone, following a rotation or a resize.
  const phone = useMediaQuery("(max-width: 48em)");
  const provision = useProvision();
  const start = useStartProvision();
  // No device read ahead of the run: this save is followed by the apply.
  const { save, valid, saving, error: saveError } = useSaveActions({ prefetchPlan: false });
  const draft = useDraftChanges();
  const info = provision.data;
  const running = info?.state === "running";
  const plan = useApplyPlan(sheet.opened && !running);
  const stale = info?.state === "failed" && info.progress.outcome === "plan-stale";
  const endedAt = info?.progress.endedAt;
  // The result, while the run that ended is recent or was watched here; the
  // review once asked for. Undecided until asked: then by the run's age.
  const [reviewing, setReviewing] = useState<boolean>();
  const [acked, setAcked] = useState<Set<string>>(new Set());
  const recent = !!endedAt && info?.state !== "idle" && Date.now() - endedAt < resultShownMs;
  const view = running ? "applying" : !(reviewing ?? !recent) && !stale ? "result" : "review";
  // One click, one run: a second click before the first save returns must not start another.
  const started = useRef(false);
  // Always mounted: read again as it opens, or what will change could be a
  // save in another tab (or a CLI run) behind.
  const { refetch } = provision;
  useEffect(() => {
    if (!sheet.opened) return;
    void refetch();
    setReviewing(undefined);
  }, [sheet.opened, refetch]);
  // A run starting shows its progress, and its end the result.
  useEffect(() => {
    if (running) setReviewing(false);
  }, [running]);
  // Refused as stale: what the devices hold now, to review again.
  const refetchPlan = plan.refetch;
  useEffect(() => {
    if (stale) void refetchPlan();
  }, [stale, refetchPlan]);

  const apply = () => {
    if (started.current) return;
    started.current = true;
    setAcked(new Set());
    void save()
      .then((saved) => {
        if (saved) start.mutate(plan.data?.verify);
      })
      .finally(() => {
        started.current = false;
      });
  };
  const upToDate = !!plan.data && !plan.data.items.length && !plan.data.unread.length && !draft.length;
  return (
    <Modal
      opened={sheet.opened}
      onClose={sheet.close}
      title={
        <Group gap={8} wrap="nowrap">
          <IconCloudUpload size={18} />
          <Text fw={600}>Save and Apply</Text>
        </Group>
      }
      size="xl"
      radius="md"
      // Pages switch without animation; a sheet over them fades in once.
      transitionProps={{ duration: 120 }}
      fullScreen={phone}
    >
      <Stack gap="lg">
        {provision.isError && (
          <Alert color="red" title="Could not load the apply status">
            {provision.error.message}
          </Alert>
        )}
        {info && view === "applying" && <RunProgress info={info} receivedAt={provision.dataUpdatedAt} />}
        {info && view === "result" && (
          <>
            <RunResult info={info} />
            <UndoSection info={info} />
          </>
        )}
        {view === "review" && (
          <Review
            query={plan}
            draft={draft}
            acked={acked}
            onAck={(key, on) => setAcked((was) => (on ? new Set([...was, key]) : new Set([...was].filter((k) => k !== key))))}
            stale={stale && !plan.isFetching}
            onReapply={apply}
          />
        )}
        {(saveError || start.error) && (
          <Alert color="red" title={saveError ? "Not saved" : "Could not start"}>
            {saveError ?? (start.error as Error).message}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={sheet.close}>
            Close
          </Button>
          {view === "result" && (
            <Button variant="default" onClick={() => setReviewing(true)}>
              Review changes
            </Button>
          )}
          {view === "review" && !upToDate && (
            <Button
              disabled={!info || !valid || saving || plan.isFetching || !readyToApply(plan.data, acked)}
              loading={saving || start.isPending}
              loaderProps={{ type: "dots" }}
              leftSection={<IconCloudUpload size={16} />}
              onClick={apply}
            >
              Save and Apply
            </Button>
          )}
        </Group>
      </Stack>
    </Modal>
  );
};
