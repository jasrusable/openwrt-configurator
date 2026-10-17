// Save and Apply, as LuCI does it: a sheet over the page you are on, opened
// by the header button, in three states, each replacing the last: the review
// (the change plan, src/applyPlan.ts), the run as it goes, and how it ended
// with Undo. Open while the URL says "?apply", so a reload during a run
// (minutes) opens it again; closing it leaves a run going. Unsaved edits are
// saved first and the plan read again: only a plan read as the sheet is open,
// of the file as saved, is applied. Starting sends the plan's file version
// and state hashes: the file or a device changed since stops the run before
// anything is armed, and the review comes back, read again.
import { Alert, Button, Group, Modal, Stack, Text } from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { IconCloudUpload } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useEffect, useRef, useState } from "react";
import { savedVersion } from "../data/api";
import { planFreshMs, planKey, useApplyPlan } from "../data/devices";
import { intentKey, useIntent } from "../data/intent";
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
      {/* Mounted only while open: each opening starts afresh (ticks, the review's age). */}
      <ApplySheet close={sheet.close} />
    </Modal>
  );
};

const ApplySheet = ({ close }: { close: () => void }) => {
  const queryClient = useQueryClient();
  const [openedAt] = useState(Date.now);
  // Read again as it opens (mounting does it), or what will change could be a
  // save in another tab (or a CLI run) behind.
  const provision = useProvision();
  const start = useStartProvision();
  const { save, valid, saving, error: saveError, merged, dirty } = useSaveActions();
  const draft = useDraftChanges();
  const intentReadAt = useIntent().dataUpdatedAt;
  const info = provision.data;
  const running = info?.state === "running";
  const plan = useApplyPlan(!running);
  const endedAt = info?.progress.endedAt;
  const recent = !!endedAt && info?.state !== "idle" && Date.now() - endedAt < resultShownMs;
  // The last start refused as a device changed: said while it is the latest run, and recent.
  const stale = recent && info?.state === "failed" && info.progress.outcome === "plan-stale";
  // The result, while the run that ended is recent or was watched here; the
  // review once asked for. Undecided until asked: then by the run's age.
  const [reviewing, setReviewing] = useState<boolean>();
  const view = running ? "applying" : !(reviewing ?? !recent) && !stale ? "result" : "review";
  // Ticks belong to the plan read they were given for: read again, ticked again.
  const [acked, setAcked] = useState<{ of: number; keys: ReadonlySet<string> }>({ of: 0, keys: new Set() });
  const ticks = acked.of === plan.dataUpdatedAt ? acked.keys : new Set<string>();
  // One click, one run: a second click before the first start answers must not start another.
  const starting = useRef(false);

  // A run starting shows its progress, and its end the result.
  useEffect(() => {
    if (running) setReviewing(false);
  }, [running]);
  // Refused as stale: what the devices hold now, to review again.
  const refetchPlan = plan.refetch;
  useEffect(() => {
    if (stale) void refetchPlan();
  }, [stale, refetchPlan]);
  // The plan and the settings as read here name different files: the older
  // read is read again, so what is reviewed is what is saved.
  const planVersion = plan.data?.version;
  const current = planVersion === savedVersion();
  useEffect(() => {
    if (current || plan.isFetching || !plan.data) return;
    void queryClient.invalidateQueries({ queryKey: plan.dataUpdatedAt < intentReadAt ? planKey : intentKey }, { cancelRefetch: false });
  }, [current, plan.isFetching, plan.data, plan.dataUpdatedAt, intentReadAt, queryClient]);

  // Applied only as reviewed: read as this sheet opened (or just before), of
  // the file saved now, and nothing left unsaved.
  const reviewed =
    !!plan.data && !plan.isFetching && !plan.isError && current && plan.dataUpdatedAt >= openedAt - planFreshMs && !dirty;
  const busy = saving || start.isPending;
  const canApply = !!info && !running && reviewed && readyToApply(plan.data, ticks) && !busy;
  const upToDate = !!plan.data && !plan.data.items.length && !plan.data.unread.length && !draft.length;

  const apply = () => {
    if (!canApply || starting.current) return;
    starting.current = true;
    start.mutate(
      { verify: plan.data?.verify, version: planVersion },
      {
        onSettled: () => {
          starting.current = false;
        },
      }
    );
  };
  // Saved, then read again (a save reads the plan): reviewed before any apply.
  const saveAndReview = () => void save();

  return (
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
          acked={ticks}
          onAck={(key, on) =>
            setAcked({ of: plan.dataUpdatedAt, keys: on ? new Set([...ticks, key]) : new Set([...ticks].filter((k) => k !== key)) })
          }
          stale={stale && !plan.isFetching}
        />
      )}
      {(saveError || merged || start.error) && (
        <Alert color={saveError || start.error ? "red" : "orange"} title={saveError ? "Not saved" : start.error ? "Could not start" : "Merged"}>
          {[saveError ?? (start.error as Error | null)?.message, merged].filter(Boolean).join(" ")}
        </Alert>
      )}
      <Group justify="flex-end" gap="xs">
        <Button variant="default" onClick={close}>
          Close
        </Button>
        {view === "result" && (
          <Button variant="default" onClick={() => setReviewing(true)}>
            Review changes
          </Button>
        )}
        {view === "review" &&
          (dirty ? (
            <Button disabled={!valid || busy} loading={saving} loaderProps={{ type: "dots" }} onClick={saveAndReview}>
              Save and review
            </Button>
          ) : (
            // Nothing to change: a quiet way to apply again anyway, under the same checks.
            <Button
              variant={upToDate ? "subtle" : "filled"}
              color={upToDate ? "gray" : undefined}
              disabled={!canApply}
              loading={start.isPending}
              loaderProps={{ type: "dots" }}
              leftSection={upToDate ? undefined : <IconCloudUpload size={16} />}
              onClick={apply}
            >
              {upToDate ? "Re-apply anyway" : "Apply"}
            </Button>
          ))}
      </Group>
    </Stack>
  );
};
