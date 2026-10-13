// Reading what devices say: JSON from ubus and iwinfo, typed loosely there,
// taken apart without trusting its shape (a field missing or of another type
// reads as nothing), and radio frequencies in the words the pages use.

export const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
export const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
export const str = (value: unknown) => (typeof value === "string" ? value : undefined);
export const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** The band a frequency (MHz) is in. */
export const bandOf = (mhz?: number) =>
  mhz === undefined ? undefined : mhz < 3000 ? "2.4 GHz" : mhz < 5925 ? "5 GHz" : "6 GHz";

/** The channel number at a frequency (MHz): 6 GHz channels reuse low numbers. */
export const channelOf = (mhz: number) =>
  mhz === 2484 ? 14 : mhz < 2500 ? (mhz - 2407) / 5 : mhz >= 5955 ? (mhz - 5950) / 5 : (mhz - 5000) / 5;
