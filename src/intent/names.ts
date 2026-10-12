// Section names from what a section is, never its place in a list: adding,
// removing or reordering one item then renames no other, so the apply diff
// shows only what changed. UCI names are letters, digits and underscores;
// network ids have no underscore, so a prefixed name never meets one.

export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "x";

/** Each name from `by`, under `prefix`; a repeat gets _2, _3 in order. */
export const uniqueNames = <T>(prefix: string, items: T[], by: (item: T) => string): string[] => {
  const seen: Record<string, number> = {};
  return items.map((item) => {
    const base = `${prefix}_${slug(by(item))}`;
    const n = (seen[base] = (seen[base] ?? 0) + 1);
    return n === 1 ? base : `${base}_${n}`;
  });
};

/** The sections, each given its `.name` from `by`. */
export const named = <S extends object>(prefix: string, sections: S[], by: (section: S) => string): S[] => {
  const names = uniqueNames(prefix, sections, by);
  return sections.map((section, i) => ({ ...section, ".name": names[i] }));
};
