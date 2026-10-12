// Section names from what a section is, never its place in a list: adding,
// removing or reordering one item then renames no other, so the apply diff
// shows only what changed. UCI names are letters, digits and underscores;
// network ids have no underscore, so a prefixed name never meets one.

export const slug = (text: string) =>
  text
    // Accents dropped rather than the letters: Café is cafe, not caf.
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "x";

/**
 * Each name from `by`, under `prefix`; a repeat gets the first free of _2,
 * _3, …: free of every name given so far, as another item's own name can be
 * a repeat's (Web, Web, Web 2), and two sections of one name would merge.
 */
export const uniqueNames = <T>(prefix: string, items: T[], by: (item: T) => string): string[] => {
  const used = new Set<string>();
  return items.map((item) => {
    const base = `${prefix}_${slug(by(item))}`;
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    return name;
  });
};

/** The sections, each given its `.name` from `by`. */
export const named = <S extends object>(prefix: string, sections: S[], by: (section: S) => string): S[] => {
  const names = uniqueNames(prefix, sections, by);
  return sections.map((section, i) => ({ ...section, ".name": names[i] }));
};
