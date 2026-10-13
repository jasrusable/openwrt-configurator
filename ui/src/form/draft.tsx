// The draft: the whole intent being edited, as one immutable value. Fields
// read it by path and write it with set(path, value); everything else is
// derived from it, never kept in step by hand: its problems (the intent
// schema, the same the server checks with, run over the whole draft) and
// whether it differs from the saved file.
import {
  createContext,
  ReactNode,
  useContext,
  useSyncExternalStore,
} from "react";
import { canonical, merge3 } from "../../../src/intent/merge";
import { Intent, intentSchema } from "../../../src/intent/schema";

/** Every dotted path into T: "networks", "networks.1", "networks.1.name"... */
type PathsOf<T, Depth extends unknown[] = []> = Depth["length"] extends 8
  ? never
  : T extends readonly (infer U)[]
    ? `${number}` | `${number}.${PathsOf<NonNullable<U>, [...Depth, 1]>}`
    : T extends object
      ? {
          [K in keyof T & string]:
            | K
            | `${K}.${PathsOf<NonNullable<T[K]>, [...Depth, 1]>}`;
        }[keyof T & string]
      : never;

export type IntentField = PathsOf<Intent>;

/** The value at a path, as a type. */
export type ValueAt<T, P extends string> = P extends `${infer K}.${infer R}`
  ? T extends readonly (infer U)[]
    ? ValueAt<NonNullable<U>, R>
    : K extends keyof T
      ? ValueAt<NonNullable<T[K]>, R>
      : never
  : T extends readonly (infer U)[]
    ? U
    : P extends keyof T
      ? T[P]
      : never;

/** The paths whose value is a list (networks, firewall.rules, ...). */
export type ListPath = {
  [P in IntentField]: NonNullable<ValueAt<Intent, P>> extends readonly unknown[]
    ? P
    : never;
}[IntentField];

export type ItemOf<N extends ListPath> = NonNullable<ValueAt<Intent, N>> extends readonly (infer U)[]
  ? U
  : never;

export type Issue = { path: string; message: string };

const isIndex = (part: string) => /^\d+$/.test(part);

export const getIn = (value: unknown, path?: string): any =>
  !path
    ? value
    : path.split(".").reduce<any>((node, part) => node?.[part], value);

/**
 * A copy of `value` with `path` set, sharing everything else (so unchanged
 * parts keep their identity). Undefined removes the key: unset is absent.
 */
export const setIn = <T,>(value: T, path: string, next: unknown): T => {
  const [head, ...rest] = path.split(".");
  const child = rest.length ? setIn((value as any)?.[head], rest.join("."), next) : next;
  if (Array.isArray(value) || (value === undefined && isIndex(head))) {
    const copy = [...((value as unknown[]) ?? [])];
    copy[Number(head)] = child;
    return copy as T;
  }
  const { [head]: _old, ...others } = (value ?? {}) as Record<string, unknown>;
  return (child === undefined ? others : { ...others, [head]: child }) as T;
};

/** The schema's problems with an intent, by dotted path. Cached per value. */
const checked = new WeakMap<object, Issue[]>();
export const issuesOf = (intent: Intent): Issue[] => {
  let issues = checked.get(intent);
  if (!issues) {
    const result = intentSchema.safeParse(intent);
    issues = result.success
      ? []
      : result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    checked.set(intent, issues);
  }
  return issues;
};

/** Whether an issue is the field's own: at its path, or at one of its list entries. */
const belongsTo = (issue: Issue, path: string) =>
  issue.path === path ||
  (issue.path.startsWith(`${path}.`) && isIndex(issue.path.slice(path.length + 1)));

const keyOf = (issue: Issue) => `${issue.path}\u0000${issue.message}`;

/**
 * Whether an edit at `touched` shows a problem: the field's own, or one of
 * the object it is in (a network's, when its name was edited). Not one of a
 * group just switched on: its settings say what is missing once edited, or
 * on Save.
 */
const shownBy = (touched: string) => (issue: Issue) =>
  belongsTo(issue, touched) || touched.startsWith(`${issue.path}.`);

/** Remembers its last answer while `deps` are the same objects, as a subscription needs. */
const memo = <T,>(compute: (...deps: unknown[]) => T) => {
  let last: { deps: unknown[]; value: T } | undefined;
  return (...deps: unknown[]): T => {
    if (!last || deps.some((dep, i) => dep !== last!.deps[i])) last = { deps, value: compute(...deps) };
    return last.value;
  };
};

export class Draft {
  private listeners = new Set<() => void>();
  /** Fields edited since the last save, as an immutable set: a new one per edit. */
  private touched: ReadonlySet<string> = new Set();
  /** What the server said was wrong with the last save, until the next edit. */
  private serverIssues: Issue[] = [];

  constructor(
    public saved: Intent,
    public value: Intent = saved,
    /**
     * Show every problem; else only those already in the saved file and
     * those of fields edited since, until Save or Add is tried (`reveal`).
     */
    private revealAll = false
  ) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private emit() {
    this.listeners.forEach((listener) => listener());
  }

  /** A clean start over `saved`: nothing edited, problems hidden again. */
  private settle(saved: Intent, value: Intent) {
    this.saved = saved;
    this.value = value;
    this.touched = new Set();
    this.revealAll = false;
    this.serverIssues = [];
    this.emit();
  }

  get = (path?: string) => getIn(this.value, path);

  set = (path: string, next: unknown) => {
    this.value = setIn(this.value, path, next);
    if (!this.touched.has(path)) this.touched = new Set([...this.touched, path]);
    this.serverIssues = [];
    this.emit();
  };

  /** Replace the whole draft, e.g. with an edit that spans settings. */
  replace = (next: Intent) => {
    this.value = next;
    this.serverIssues = [];
    this.emit();
  };

  /** Back to the saved file; or a newly saved one becomes the saved file. */
  reset = (saved: Intent = this.saved) => this.settle(saved, saved);

  /**
   * `sent` was saved as `stored`. Edits made while it was on its way are
   * kept: the draft becomes the stored file only if it is still what was sent.
   */
  savedAs = (sent: Intent, stored: Intent) => {
    if (this.value === sent) return this.settle(stored, stored);
    this.saved = stored;
    this.serverIssues = [];
    this.emit();
  };

  /**
   * The saved file changed elsewhere (another tab, the CLI, a login read it
   * again): the edits made over the old file are replayed onto the new one,
   * so saving keeps the other change too (`merge3`).
   */
  rebase = (saved: Intent, base: Intent = this.saved) => {
    if (saved === this.saved && base === this.saved) return;
    this.value = merge3(base, this.value, saved);
    this.saved = saved;
    this.emit();
  };

  /** Every problem shows, as when Save or Add is tried. */
  reveal = () => {
    this.revealAll = true;
    this.emit();
  };

  setServerIssues = (issues: Issue[]) => {
    this.serverIssues = issues;
    this.emit();
  };

  private all = memo((own, server) =>
    (server as Issue[]).length ? [...(own as Issue[]), ...(server as Issue[])] : (own as Issue[])
  );

  /** Every problem, shown or not: what Save checks. The same array while nothing changed. */
  issues = (): Issue[] => this.all(issuesOf(this.value), this.serverIssues);

  private visible = memo((all, saved, touched, revealAll) => {
    if (revealAll) return all as Issue[];
    const before = new Set(issuesOf(saved as Intent).map(keyOf));
    const edited = [...(touched as ReadonlySet<string>)].map(shownBy);
    return (all as Issue[]).filter(
      (issue) => before.has(keyOf(issue)) || edited.some((shows) => shows(issue))
    );
  });

  /** The problems to show: the header's list, the sidebar's counts, the red marks. */
  shownIssues = (): Issue[] => this.visible(this.issues(), this.saved, this.touched, this.revealAll);

  /** The message to show on a field, if it has a problem and may show it. */
  errorFor = (path: string): string | undefined =>
    this.shownIssues().find((issue) => belongsTo(issue, path))?.message;

  private differs = memo((value, saved) => canonical(value) !== canonical(saved));

  changed = (): boolean => this.differs(this.value, this.saved);
}

const DraftContext = createContext<Draft | null>(null);

export const DraftProvider = ({ draft, children }: { draft: Draft; children: ReactNode }) => (
  <DraftContext.Provider value={draft}>{children}</DraftContext.Provider>
);

export const useDraft = () => {
  const draft = useContext(DraftContext);
  if (!draft) throw new Error("useDraft outside a DraftProvider");
  return draft;
};

/**
 * Something read off the draft, re-rendering only when it changes: `read`
 * must give the same value (a string, or the same object) while what it
 * reads is unchanged.
 */
export const useDerived = <T,>(read: (draft: Draft) => T): T => {
  const draft = useDraft();
  return useSyncExternalStore(draft.subscribe, () => read(draft));
};

/** The draft's value at a path (or the whole draft), re-rendering when it changes. */
export function useDraftValue(): Intent;
export function useDraftValue<P extends IntentField>(path: P): ValueAt<Intent, P> | undefined;
export function useDraftValue(path?: string): unknown {
  return useDerived((d) => d.get(path));
}

/** A list in the draft and its edits: add an item, change or remove one by its place. */
export const useDraftList = <N extends ListPath>(path: N) => {
  const draft = useDraft();
  const items: ItemOf<N>[] = useDerived((d) => d.get(path)) ?? [];
  const set = (next: ItemOf<N>[]) => draft.set(path, next);
  return {
    items,
    add: (item: ItemOf<N>) => set([...items, item]),
    update: (index: number, item: ItemOf<N>) => set(items.map((old, i) => (i === index ? item : old))),
    remove: (index: number) => set(items.filter((_, i) => i !== index)),
  };
};

/** The problems to show (see Draft.shownIssues). */
export const useIssues = () => useDerived((d) => d.shownIssues());

/** The problem to show on a field, if any. */
export const useFieldError = (path: string) => useDerived((d) => d.errorFor(path));

/** Whether the draft differs from the saved file. */
export const useDraftChanged = () => useDerived((d) => d.changed());
