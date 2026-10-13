// What was last read from the devices (facts, status, the apply diff), kept in
// this browser so a reload shows it at once, with its age, while the pages
// read it again. A per-viewer convenience: nothing here is the truth, every
// page still refreshes as it opens. No secrets: the diff only ever says
// "(hidden)" for them, and facts and status hold none. Dropped when a router
// session ends (a 401), so a logged-out browser keeps nothing of the network.
import { QueryClient } from "@tanstack/react-query";

/** The queries worth keeping: device reads, slow to make again. */
const kept = ["devices", "network-status", "status-history", "apply-diff"];

/**
 * The shape of what is kept: raised when a kept read's shape changes, so a
 * read kept by an older build is dropped rather than shown to code that
 * expects the new one.
 */
export const format = 3;

/** Per place the app is served (the Mac's server, or a router's /cgi-bin/onc/), and per format. */
const storageKey = () => `onc-cache:${format}:${location.pathname}`;

// What older formats kept, gone.
try {
  for (let f = 1; f < format; f++) localStorage.removeItem(f === 1 ? `onc-cache:${location.pathname}` : `onc-cache:${f}:${location.pathname}`);
} catch {
  // Storage blocked.
}

/** Older than this is not worth showing, even as a placeholder. */
const maxAgeMs = 24 * 60 * 60 * 1000;

type Saved = Record<string, { data: unknown; updatedAt: number }>;

const read = (): Saved => {
  try {
    return JSON.parse(localStorage.getItem(storageKey()) ?? "{}") as Saved;
  } catch {
    return {};
  }
};

const write = (saved: Saved) => {
  try {
    localStorage.setItem(storageKey(), JSON.stringify(saved));
  } catch {
    // Storage blocked or full (a private window): only the convenience is lost.
  }
};

/** Put back what was kept, as of when it was read; then keep each new read. */
export const persistDeviceReads = (queryClient: QueryClient) => {
  const now = Date.now();
  // Kept by the whole query key ("network-status:clients"), so each Status page has its own.
  Object.entries(read()).forEach(([key, { data, updatedAt }]) => {
    if (kept.includes(key.split(":")[0]) && now - updatedAt < maxAgeMs) {
      queryClient.setQueryData(key.split(":"), data, { updatedAt });
    }
  });
  queryClient.getQueryCache().subscribe((event) => {
    const queryKey = event.query.queryKey;
    // Only a new read: not each fetch starting or failing, which would rewrite it all again.
    if (event.type !== "updated" || event.action.type !== "success") return;
    if (typeof queryKey[0] !== "string" || !kept.includes(queryKey[0])) return;
    const { data, dataUpdatedAt } = event.query.state;
    if (data === undefined) return;
    // Older reads are dropped, not only skipped: nothing of the network lingers past a day.
    const fresh = Object.fromEntries(Object.entries(read()).filter(([, v]) => Date.now() - v.updatedAt < maxAgeMs));
    write({ ...fresh, [queryKey.join(":")]: { data, updatedAt: dataUpdatedAt } });
  });
};

/** Forget everything kept, the Status graphs' history too: a router session ended. */
export const forgetDeviceReads = () => {
  try {
    localStorage.removeItem(storageKey());
  } catch {
    // Nothing was kept.
  }
};
