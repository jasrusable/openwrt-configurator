// What is derived from the site rather than stored: stable ids that grow
// from its seed (its first name), so the same site always gets the same ones.
import type { Intent } from "./schema";

/** What the site's derived ids grow from: its first name, kept across renames (schema's `site_id`). */
export const siteSeed = (intent: Pick<Intent, "system">) => intent.system.site_id ?? intent.system.name;

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
