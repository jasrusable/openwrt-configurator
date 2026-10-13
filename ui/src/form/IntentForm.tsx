// The whole UI edits one draft: the intent file (draft.tsx). This is where
// it is created from what the server has, and saved or reverted.
import { ReactNode, useEffect, useState } from "react";
import { Intent } from "../../../src/intent/schema";
import { SaveError } from "../data/api";
import { useSaveIntent } from "../data/intent";
import { whereIs } from "../settingPages";
import { Draft, DraftProvider, useDraft, useDraftChanged, useIssues } from "./draft";

export type { IntentField } from "./draft";
export { useDraftChanged } from "./draft";

/**
 * Edits not yet saved when the form was taken down: only a router session
 * ending does that (it mounts once otherwise). Kept in memory, never storage
 * (they can hold passwords), and put back once logged in again.
 */
let unsavedAtLogout: Intent | undefined;

/** The draft of `intent`, for every page below. */
export const IntentForm = ({ intent, children }: { intent: Intent; children: ReactNode }) => {
  // Made once: a save (draft.savedAs) or a file changed elsewhere (rebase)
  // moves it on, so nothing on the page starts again, a VPN client's key
  // shown once included.
  const [draft] = useState(() => {
    const made = new Draft(intent);
    if (unsavedAtLogout) made.replace(unsavedAtLogout);
    unsavedAtLogout = undefined;
    return made;
  });
  useEffect(() => draft.rebase(intent), [draft, intent]);
  useEffect(
    () => () => {
      if (draft.changed()) unsavedAtLogout = draft.value;
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

  // Shown beside the buttons, not as a toast; a save that works says
  // nothing (Save greys out).
  const [error, setError] = useState<string>();
  const submit = async () => {
    if (issues.length) return;
    setError(undefined);
    try {
      const sent = draft.value;
      draft.savedAs(sent, await save.mutateAsync(sent));
    } catch (e) {
      // A setting's own problem shows at it; one no settings page owns (the
      // compiler's, on low-level config) is the save's message, or Save would
      // stay greyed by a problem nothing on screen can fix or point to.
      const placed = e instanceof SaveError ? e.issues.filter((issue) => whereIs(issue.path)) : [];
      const unplaced = e instanceof SaveError ? e.issues.filter((issue) => !whereIs(issue.path)) : [];
      if (e instanceof SaveError) draft.setServerIssues(placed);
      setError([(e as Error).message, ...unplaced.map((issue) => issue.message)].join(" "));
    }
  };

  return {
    save: submit,
    revert: () => {
      setError(undefined);
      draft.reset();
    },
    error,
    dirty,
    valid: issues.length === 0,
    issues,
    saving: save.isPending,
  };
};
