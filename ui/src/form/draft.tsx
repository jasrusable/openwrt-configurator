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

/** JSON with sorted keys: equal drafts compare equal however they were built. */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
      : v
  );

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

export class Draft {
  private listeners = new Set<() => void>();
  private touched = new Set<string>();
  private changedCache?: { value: Intent; saved: Intent; changed: boolean };
  /** What the server said was wrong with the last save, until the next edit. */
  private serverIssues: Issue[] = [];

  constructor(
    public saved: Intent,
    public value: Intent = saved,
    /** Show every problem, or only those of fields edited so far (a new item's page). */
    private revealAll = true
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

  get = (path?: string) => getIn(this.value, path);

  set = (path: string, next: unknown) => {
    this.value = setIn(this.value, path, next);
    this.touched.add(path);
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
  reset = (saved: Intent = this.saved) => {
    this.saved = saved;
    this.value = saved;
    this.touched.clear();
    this.serverIssues = [];
    this.emit();
  };

  reveal = () => {
    this.revealAll = true;
    this.emit();
  };

  setServerIssues = (issues: Issue[]) => {
    this.serverIssues = issues;
    this.emit();
  };

  private combined?: { own: Issue[]; server: Issue[]; all: Issue[] };

  /** The same array while nothing changed, as a subscription needs. */
  issues = (): Issue[] => {
    const own = issuesOf(this.value);
    if (!this.serverIssues.length) return own;
    const c = this.combined;
    if (c?.own !== own || c.server !== this.serverIssues) {
      this.combined = { own, server: this.serverIssues, all: [...own, ...this.serverIssues] };
    }
    return this.combined!.all;
  };

  /** The message to show on a field, if it has a problem and may show it. */
  errorFor = (path: string): string | undefined => {
    const shown =
      this.revealAll ||
      [...this.touched].some((t) => t === path || t.startsWith(`${path}.`) || path.startsWith(`${t}.`));
    return shown ? this.issues().find((issue) => belongsTo(issue, path))?.message : undefined;
  };

  changed = (): boolean => {
    const cache = this.changedCache;
    if (cache?.value === this.value && cache.saved === this.saved) return cache.changed;
    const changed = canonical(this.value) !== canonical(this.saved);
    this.changedCache = { value: this.value, saved: this.saved, changed };
    return changed;
  };
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

const useDerived = <T,>(read: (draft: Draft) => T): T => {
  const draft = useDraft();
  return useSyncExternalStore(draft.subscribe, () => read(draft));
};

/** The draft's value at a path (or the whole draft), re-rendering when it changes. */
export const useDraftValue = (path?: IntentField): any => useDerived((d) => d.get(path));

/** Every problem with the draft. */
export const useIssues = () => useDerived((d) => d.issues());

/** The problem to show on a field, if any. */
export const useFieldError = (path: string) => useDerived((d) => d.errorFor(path));

/** Whether the draft differs from the saved file. */
export const useDraftChanged = () => useDerived((d) => d.changed());
