// What a radio may be set to, the same for the schema, the compiler and the
// UI's choices: each band's channels, the widths, and the mesh's own.
import type { Intent } from "./schema";

export const bands = ["2g", "5g", "6g"] as const;

export type Band = (typeof bands)[number];

export const bandLabels: Record<Band, string> = { "2g": "2.4 GHz", "5g": "5 GHz", "6g": "6 GHz" };

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step);

/**
 * The channels a radio can be pinned to, per band (hostapd will not start on
 * another band's). 2.4 GHz stops at 13: 14 is Japan's, 802.11b only.
 */
export const channelsOf: Record<"2g" | "5g", readonly number[]> = {
  "2g": range(1, 13, 1),
  "5g": [...range(36, 64, 4), ...range(100, 144, 4), ...range(149, 177, 4)],
};

/** MHz; "auto" picks the band's usual width. */
export const channelWidths = ["auto", "20", "40", "80", "160"] as const;

/** The VLAN that carries the mesh over cables (wifi.mesh.over_cable): no network may use it. */
export const meshWiredVlan = 4000;

/** The bands a mesh can use, and their channels no radar (DFS) can move it off. */
export const meshBands = ["2g", "5g", "6g"] as const;
export type MeshBand = (typeof meshBands)[number];
export const meshChannels: Record<MeshBand, number[]> = {
  "2g": [1, 6, 11],
  "5g": [36, 40, 44, 48],
  // 6 GHz has no radar channels: its preferred (PSC) ones, which devices scan first.
  "6g": [37, 53, 69, 85],
};

type WifiSettings = Pick<Intent["wifi"], "radios" | "mesh">;

/**
 * The bands an SSID is broadcast on: its own (unset, every band) whose radios
 * are on, less the mesh's when the mesh has it to itself.
 */
export const broadcastBands = (wifi: WifiSettings, ssid: { bands?: readonly Band[] }) =>
  bands.filter(
    (band) =>
      wifi.radios[band].enabled &&
      (!ssid.bands || ssid.bands.includes(band)) &&
      !(wifi.mesh.enabled && wifi.mesh.band_reserved && wifi.mesh.band === band)
  );
