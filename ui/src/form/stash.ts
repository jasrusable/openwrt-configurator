// Unsaved edits kept across a reload (and a router login ending): the draft
// and the saved file it was made over, in sessionStorage. Never localStorage:
// a draft can hold passwords and keys, and sessionStorage goes with the tab.
// Put back over the file as it is now (Draft.rebase, merge3), so a change
// made elsewhere meanwhile is kept, and an edit wins where both changed one
// setting.
import { Intent, intentSchema } from "../../../src/intent/schema";
import { siteOf } from "../data/persist";

/** Raised when what is kept changes shape: an older tab's is then dropped. */
const format = 1;
const maxAge = 24 * 60 * 60 * 1000;

type Kept = { format: number; site: string; at: number; base: Intent; value: Intent };
export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;
/** What is kept of a draft (draft.tsx's Draft). */
export type Edited = { subscribe: (listener: () => void) => () => void; changed: () => boolean; saved: Intent; value: Intent };

/** sessionStorage, or none where the browser refuses it: a reload then loses the edits, as it did before. */
const session = (): Store | undefined => {
  try {
    return sessionStorage;
  } catch {
    return undefined;
  }
};

const key = () => `onc-draft:${location.pathname}`;

/**
 * Edits an earlier load of this tab left over `saved`'s network. None when
 * they are another network's, a day old, kept in an older format, or made
 * over a file this build's schema no longer reads (an update changed it).
 */
export const keptEdits = (saved: Intent, store = session()): { base: Intent; value: Intent } | undefined => {
  try {
    const kept = JSON.parse(store?.getItem(key()) ?? "null") as Kept | null;
    const usable =
      kept?.format === format &&
      kept.site === siteOf(saved) &&
      Date.now() - kept.at < maxAge &&
      intentSchema.safeParse(kept.base).success;
    return usable ? { base: kept.base, value: kept.value } : undefined;
  } catch {
    return undefined;
  }
};

/** Keeps the draft's edits as they change; none once saved or reverted. Returns the unsubscribe. */
export const keepEdits = (draft: Edited, store = session()) =>
  draft.subscribe(() => {
    try {
      if (!draft.changed()) return store?.removeItem(key());
      const kept: Kept = { format, site: siteOf(draft.saved), at: Date.now(), base: draft.saved, value: draft.value };
      store?.setItem(key(), JSON.stringify(kept));
    } catch {
      // Full or refused: the edits stay on the page, only a reload loses them.
    }
  });
