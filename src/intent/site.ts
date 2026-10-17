// What is derived from the site rather than stored: stable ids that grow
// from its seed (its first name), so the same site always gets the same ones.
import type { Intent } from "./schema";

/**
 * What the site's derived ids grow from, and which network settings are of:
 * its `site_id` (random for a network started here; its first name, kept
 * across renames, for one that had none), else its name.
 */
export const siteSeed = (intent: { system: Pick<Intent["system"], "site_id" | "name"> }) => intent.system.site_id ?? intent.system.name;

/** Which network any JSON says it is (siteSeed): undefined when it names none. */
export const siteOfJson = (json: unknown): string | undefined => {
  const system = (json as { system?: { site_id?: unknown; name?: unknown } } | undefined)?.system;
  const seed = system?.site_id ?? system?.name;
  return typeof seed === "string" ? seed : undefined;
};

/**
 * A new network's site id: 16 random hex digits, so two networks named alike
 * are never taken for one. Unique, not secret: Math.random, as QuickJS has
 * no crypto.
 */
export const newSiteId = () =>
  Array.from({ length: 4 }, () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0")).join("");

/** FNV-1a, 32-bit, as 8 hex digits: a stable value derived from a name. */
export const fnv = (text: string) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};

/**
 * A stable unique-local IPv6 prefix for the site. RFC 4193 wants the 40-bit
 * global ID random; derived from the site's seed it is still unlikely to
 * clash, and it never changes, without being stored anywhere.
 */
export const ulaPrefix = (seed: string) => {
  // Two runs give 64 bits, of which 40 are used.
  const hex = fnv(seed) + fnv(`${seed}/ula`);
  return `fd${hex.slice(0, 2)}:${hex.slice(2, 6)}:${hex.slice(6, 10)}::/48`;
};
