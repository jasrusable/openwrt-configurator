// The whole UI edits one draft: the intent file (draft.tsx). This is where
// it is created from what the server has, and saved or reverted.
import { notifications } from "@mantine/notifications";
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

  const submit = async () => {
    if (issues.length) {
      notifications.show({ message: "Some settings need fixing.", color: "red" });
      return;
    }
    try {
      draft.reset(await save.mutateAsync(draft.value));
      notifications.show({ message: "Saved.", color: "green" });
    } catch (e) {
      if (e instanceof SaveError) {
        draft.setServerIssues(e.issues);
      }
      notifications.show({ message: (e as Error).message, color: "red" });
    }
  };

  return {
    save: submit,
    revert: () => draft.reset(),
    dirty,
    valid: issues.length === 0,
    issues,
    saving: save.isPending,
  };
};
