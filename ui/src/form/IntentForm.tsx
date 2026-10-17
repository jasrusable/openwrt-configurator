// The whole UI edits one draft: the intent file (draft.tsx). This is where
// it is created from what the server has, and saved or reverted.
import { ReactNode, useEffect, useState } from "react";
import { Intent } from "../../../src/intent/schema";
import { SaveError } from "../data/api";
import { useSaveIntent } from "../data/intent";
import { whereIs } from "../settingPages";
import { describePath } from "../../../src/intent/diff";
import { Draft, DraftProvider, MergeNote, useDraft, useDraftChanged, useDraftNotes, useIssues } from "./draft";
import { keepEdits, keptEdits } from "./stash";

/** The draft of `intent`, for every page below. */
export const IntentForm = ({ intent, children }: { intent: Intent; children: ReactNode }) => {
  // Made once: a save (draft.savedAs) or a file changed elsewhere (rebase)
  // moves it on, so nothing on the page starts again, a VPN client's key
  // shown once included. Edits a reload left are put back over the file as
  // it is now (stash.ts); a login ending forgets them.
  const [draft] = useState(() => {
    const kept = keptEdits(intent);
    const made = new Draft(kept?.base ?? intent, kept?.value);
    made.rebase(intent);
    return made;
  });
  useEffect(() => draft.rebase(intent), [draft, intent]);
  useEffect(() => keepEdits(draft), [draft]);
  return (
    <DraftProvider draft={draft}>
      <LeaveGuard />
      {children}
    </DraftProvider>
  );
};

/** Leaving or reloading with unsaved edits asks first, as the browser does it. */
const LeaveGuard = () => {
  const dirty = useDraftChanged();
  useEffect(() => {
    if (!dirty) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", ask);
    return () => window.removeEventListener("beforeunload", ask);
  }, [dirty]);
  return null;
};

/** A merge in words: that it happened, and where an edit was kept over the other change. */
export const mergeWords = ({ conflicts }: MergeNote, intent: Intent) =>
  [
    "A change saved elsewhere was merged into your edits.",
    conflicts.length
      ? `Where both changed it, yours was kept: ${conflicts.map((path) => describePath(path ? path.split(".") : [], intent).join(" › ") || "everything").join("; ")}.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

/** Save and revert, for the toolbar and for Save and Apply. */
export const useSaveActions = ({ prefetchPlan = true }: { prefetchPlan?: boolean } = {}) => {
  const draft = useDraft();
  const save = useSaveIntent({ prefetchPlan });
  const dirty = useDraftChanged();
  const issues = useIssues();
  const { saveError, merged } = useDraftNotes();

  // Shown beside the buttons, not as a toast, until the next edit (a merge
  // after a refused save makes a new draft, not an edit); a save that works
  // says nothing (Save greys out).
  // True when the draft is saved, or there was nothing to save. False when
  // problems stopped it or the save failed: the caller must not apply.
  const submit = async (): Promise<boolean> => {
    if (!draft.changed()) return true;
    // Problems hidden until now (a group just switched on) show, and stop it.
    if (draft.issues().length) {
      draft.reveal();
      return false;
    }
    const sent = draft.value;
    try {
      draft.savedAs(sent, await save.mutateAsync(sent));
      return true;
    } catch (e) {
      // A setting's own problem shows at it; one no settings page owns (the
      // compiler's, on low-level config) is the save's message, or Save would
      // stay greyed by a problem nothing on screen can fix or point to.
      const all = e instanceof SaveError ? e.issues : [];
      const placed = all.filter((issue) => whereIs(issue.path));
      const unplaced = all.filter((issue) => !whereIs(issue.path));
      if (e instanceof SaveError) draft.setServerIssues(placed);
      draft.failed([(e as Error).message, ...unplaced.map((issue) => issue.message)].join(" "));
      return false;
    }
  };

  return {
    save: submit,
    revert: () => draft.reset(),
    error: saveError,
    merged: merged && mergeWords(merged, draft.value),
    dirty,
    // Only problems on screen grey Save out: with hidden ones, Save shows them.
    valid: issues.length === 0,
    issues,
    saving: save.isPending,
  };
};
