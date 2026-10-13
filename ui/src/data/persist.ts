// What was last read from the devices (facts, status, the apply plan), kept in
// this browser so a reload shows it at once, with its age, while the pages
// read it again. A per-viewer convenience: nothing here is the truth, every
// page still refreshes as it opens. No secrets: the plan only ever says
// "(hidden)" for them, and facts and status hold none. Dropped when a router
// session ends (a 401), so a logged-out browser keeps nothing of the network;
// kept per network (the settings' site id), so one served from the same
// address before (a sample copy) never shows as yours.
import { QueryClient } from "@tanstack/react-query";

/** The queries worth keeping: device reads, slow to make again. */
const kept = ["devices", "network-status", "status-history", "apply-plan"];

/**
 * The shape of what is kept: raised when a kept read's shape changes, so a
 * read kept by an older build is dropped rather than shown to code that
 * expects the new one.
 */
export const format = 5;

/** Which network the reads are of: one origin can serve another intent (a sample copy, then your own), whose reads must never show. */
let site: string | undefined;

/** A short hash of the saved settings' identity: its site id, else its name. */
export const siteOf = (intent: { system?: { site_id?: string; name?: string } } | undefined) => {
  const id = intent?.system?.site_id ?? intent?.system?.name ?? "";
  return [...id].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0, 2166136261).toString(36);
};

/** Per place the app is served (the Mac's server, or a router's /cgi-bin/onc/), per format, and per network. */
const prefix = () => `onc-cache:${format}:${location.pathname}`;
const storageKey = () => `${prefix()}:${site}`;

/** Every key kept for this place, any format or network. */
const keptKeys = () => {
  try {
    return Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i) ?? "").filter((k) => k.startsWith("onc-cache:"));
  } catch {
    return [];
  }
};

// What older formats kept, gone.
keptKeys()
  .filter((k) => !k.startsWith(`onc-cache:${format}:`))
  .forEach((k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      // Storage blocked.
    }
  });

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

/** Put back what was kept for this network, as of when it was read. */
const restore = (queryClient: QueryClient) => {
  const now = Date.now();
  // Kept by the whole query key ("network-status:clients"), so each Status page has its own.
  Object.entries(read()).forEach(([key, { data, updatedAt }]) => {
    if (kept.includes(key.split(":")[0]) && now - updatedAt < maxAgeMs) {
      queryClient.setQueryData(key.split(":"), data, { updatedAt });
    }
  });
};

/**
 * Once the settings are read (and so which network this is), put back what
 * was kept for it; then keep each new read under it. Another network's
 * reads are never put back.
 */
export const persistDeviceReads = (queryClient: QueryClient) => {
  queryClient.getQueryCache().subscribe((event) => {
    const queryKey = event.query.queryKey;
    // Only a new read: not each fetch starting or failing, which would rewrite it all again.
    if (event.type !== "updated" || event.action.type !== "success") return;
    const { data, dataUpdatedAt } = event.query.state;
    if (queryKey[0] === "intent") {
      const now = siteOf(data as Parameters<typeof siteOf>[0]);
      if (now === site) return;
      // Another network than what is shown: its reads go, this one's come back.
      if (site !== undefined) kept.forEach((key) => queryClient.removeQueries({ queryKey: [key] }));
      site = now;
      restore(queryClient);
      return;
    }
    if (site === undefined || typeof queryKey[0] !== "string" || !kept.includes(queryKey[0])) return;
    if (data === undefined) return;
    // Older reads are dropped, not only skipped: nothing of the network lingers past a day.
    const fresh = Object.fromEntries(Object.entries(read()).filter(([, v]) => Date.now() - v.updatedAt < maxAgeMs));
    write({ ...fresh, [queryKey.join(":")]: { data, updatedAt: dataUpdatedAt } });
  });
};

/** Forget everything kept, for every network served here, the Status graphs' history too: a router session ended. */
export const forgetDeviceReads = () =>
  keptKeys()
    .filter((k) => k.startsWith(`${prefix()}:`))
    .forEach((k) => {
      try {
        localStorage.removeItem(k);
      } catch {
        // Nothing was kept.
      }
    });
