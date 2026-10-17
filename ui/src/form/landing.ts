// Arriving at one setting: a link with `?at=<path>` (settingUrl, from Edit ›
// on a status page or a ⌘K result) scrolls its page to that setting's row
// and marks it for a moment, its control focused. A row is found by the
// setting it edits (`data-setting`, SettingRow); while the page is still
// rendering it is looked for again, then the nearest setting holding it (a
// list item, a section), then the page's top is where it lands.
import { useEffect } from "react";
import { useLocation } from "react-router";

/** How long to look for the row itself (a tab or a list renders late), then for one holding it. */
const lookMs = { exact: 600, any: 1200, every: 50 };
const markedMs = 2000;

const rowOf = (path: string, exactOnly: boolean) => {
  const parts = path.split(".");
  const tried = exactOnly ? [path] : parts.map((_, i) => parts.slice(0, parts.length - i).join("."));
  for (const p of tried) {
    const row = document.querySelector<HTMLElement>(`[data-setting="${CSS.escape(p)}"]`);
    if (row) return row;
  }
  return undefined;
};

const land = (row: HTMLElement) => {
  // At once, as pages switch (no animation, as macOS Settings).
  row.scrollIntoView({ block: "center", behavior: "instant" });
  row.classList.add("onc-landed");
  // The control, never the label's ⓘ (focusing it would open its card).
  row.querySelector<HTMLElement>(".onc-row-control :is(input:not([type=hidden]), textarea, button, [tabindex='0'])")?.focus({ preventScroll: true });
  setTimeout(() => row.classList.remove("onc-landed"), markedMs);
};

export const useLanding = () => {
  const { pathname, search } = useLocation();
  useEffect(() => {
    const at = new URLSearchParams(search).get("at");
    if (!at) return;
    const started = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = () => {
      const waited = Date.now() - started;
      const row = rowOf(at, waited < lookMs.exact);
      if (row) land(row);
      else if (waited < lookMs.any) timer = setTimeout(look, lookMs.every);
    };
    look();
    return () => clearTimeout(timer);
  }, [pathname, search]);
};
