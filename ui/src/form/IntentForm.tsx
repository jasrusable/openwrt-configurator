// The whole UI edits one draft: the intent file (draft.tsx). This is where
// it is created from what the server has, and saved or reverted.
import { ReactNode, useEffect, useState } from "react";
import { Intent } from "../../../src/intent/schema";
import { SaveError } from "../data/api";
import { useSaveIntent } from "../data/intent";
import { whereIs } from "../settingPages";
import { Draft, DraftProvider, useDraft, useDraftChanged, useDraftValue, useIssues } from "./draft";

export type { IntentField } from "./draft";
export { useDraftChanged } from "./draft";

/**
 * Edits not yet saved when the form was taken down: only a router session
 * ending does that (it mounts once otherwise). Kept in memory, never storage
 * (they can hold passwords), and put back once logged in again.
 */
let unsavedAtLogout: { base: Intent; value: Intent } | undefined;

/** The draft of `intent`, for every page below. */
export const IntentForm = ({ intent, children }: { intent: Intent; children: ReactNode }) => {
  // Made once: a save (draft.savedAs) or a file changed elsewhere (rebase)
  // moves it on, so nothing on the page starts again, a VPN client's key
  // shown once included.
  const [draft] = useState(() => {
    const made = new Draft(unsavedAtLogout?.base ?? intent, unsavedAtLogout?.value);
    made.rebase(intent);
    unsavedAtLogout = undefined;
    return made;
  });
  useEffect(() => draft.rebase(intent), [draft, intent]);
  useEffect(
    () => () => {
      if (draft.changed()) unsavedAtLogout = { base: draft.saved, value: draft.value };
    },
    [draft]
  );
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

/** Save and revert, for the toolbar. */
export const useSaveActions = () => {
  const draft = useDraft();
  const save = useSaveIntent();
  const dirty = useDraftChanged();
  const issues = useIssues();
  const value = useDraftValue();

  // Shown beside the buttons, not as a toast, until the draft changes; a
  // save that works says nothing (Save greys out).
  const [failed, setFailed] = useState<{ message: string; value: Intent }>();
  const submit = async () => {
    setFailed(undefined);
    // Problems hidden until now (a group just switched on) show, and stop it.
    if (draft.issues().length) return draft.reveal();
    const sent = draft.value;
    try {
      draft.savedAs(sent, await save.mutateAsync(sent));
    } catch (e) {
      // A setting's own problem shows at it; one no settings page owns (the
      // compiler's, on low-level config) is the save's message, or Save would
      // stay greyed by a problem nothing on screen can fix or point to.
      const all = e instanceof SaveError ? e.issues : [];
      const placed = all.filter((issue) => whereIs(issue.path));
      const unplaced = all.filter((issue) => !whereIs(issue.path));
      if (e instanceof SaveError) draft.setServerIssues(placed);
      setFailed({ message: [(e as Error).message, ...unplaced.map((issue) => issue.message)].join(" "), value: sent });
    }
  };

  return {
    save: submit,
    revert: () => {
      setFailed(undefined);
      draft.reset();
    },
    error: failed?.value === value ? failed.message : undefined,
    dirty,
    // Only problems on screen grey Save out: with hidden ones, Save shows them.
    valid: issues.length === 0,
    issues,
    saving: save.isPending,
  };
};
