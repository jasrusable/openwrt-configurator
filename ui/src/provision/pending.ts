// How many settings Save and Apply would send: the saved file's pending
// changes plus edits still in the draft. The first apply has no count: it
// writes the whole configuration, so 0 would say there was nothing to send.
import type { Change } from "../../../src/intent/diff";
import { diffIntent } from "../../../src/intent/diff";
import { useProvision } from "../data/provision";
import type { Intent } from "../../../src/intent/schema";
import { useDerived } from "../form/draft";

/** The last diff made: every button and sheet asking about one draft shares it. */
let last: { saved: Intent; value: Intent; changes: Change[] } | undefined;
const changesOf = (saved: Intent, value: Intent) => {
  if (last?.saved !== saved || last.value !== value) last = { saved, value, changes: diffIntent(saved, value) };
  return last.changes;
};

/** Edits not saved yet, in the same terms as the sheet's change list. */
export const useDraftChanges = (): Change[] => useDerived((d) => changesOf(d.saved, d.value));

/** Rows the sheet will list: the draft's edit wins where both name the same change. */
export const pendingCount = (saved: Change[], draft: Change[]): number => {
  const rows = new Map<string, Change>();
  for (const change of saved) rows.set(`${change.kind}:${change.path}`, change);
  for (const change of draft) rows.set(`${change.kind}:${change.path}`, change);
  return rows.size;
};

/** Undefined until something has been applied from here. */
export const useApplyCount = (): number | undefined => {
  const info = useProvision().data;
  const draft = useDraftChanges();
  if (!info || info.live === "none") return undefined;
  return pendingCount(info.changes, draft);
};

/** The apply button's words: what it does, and beneath it how many changes wait (none on a first apply, which writes everything). */
/** `opensSheet`: the header's button, which shows what will change first ("…", as a button that opens a dialog says). */
export const applyActionLabel = (count: number | undefined, running = false, opensSheet = false) =>
  running
    ? { title: "Applying…" }
    : {
        title: opensSheet ? "Save and Apply…" : "Save and Apply",
        ...(count === undefined ? {} : { detail: count === 0 ? "No changes" : `${count} change${count === 1 ? "" : "s"}` }),
      };
