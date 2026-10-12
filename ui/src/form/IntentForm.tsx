// The whole UI edits one draft: the intent file (draft.tsx). This is where
// it is created from what the server has, and saved or reverted.
import { ReactNode, useState } from "react";
import { Intent } from "../../../src/intent/schema";
import { SaveError } from "../data/api";
import { useSaveIntent } from "../data/intent";
import { Draft, DraftProvider, useDraft, useDraftChanged, useIssues } from "./draft";

export type { IntentField } from "./draft";
export { useDraftChanged } from "./draft";

/** The draft of `intent`, for every page below. */
export const IntentForm = ({ intent, children }: { intent: Intent; children: ReactNode }) => {
  const [draft] = useState(() => new Draft(intent));
  return <DraftProvider draft={draft}>{children}</DraftProvider>;
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
      if (e instanceof SaveError) {
        draft.setServerIssues(e.issues);
      }
      setError((e as Error).message);
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
