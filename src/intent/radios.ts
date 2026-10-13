// What a radio may be set to, the same for the schema, the compiler and the
// UI's choices: each band's channels, the widths, and the mesh's own.
import { where } from "./places";
import { regdb } from "./wifi/regdb";
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

/** The radio section the compiler declares for each band, named as OpenWrt names a device's, with its usual width (MHz). */
export const radios: { band: Band; name: string; width: string }[] = [
  { band: "2g", name: "radio0", width: "20" },
  { band: "5g", name: "radio1", width: "80" },
  { band: "6g", name: "radio2", width: "160" },
];

/**
 * The widest a band's radio is set to (MHz): its setting, else the band's
 * usual; the mesh's band at most 80 MHz on 5 GHz, as wider reaches radar
 * channels. One rule for every node's radio, the router's mesh one included,
 * or the mesh's links would differ by node.
 */
export const radioWidth = (intent: Intent, band: Band) => {
  const settings = intent.wifi.radios[band];
  const usual = radios.find((r) => r.band === band)!.width;
  const width = settings.width === "auto" ? usual : settings.width;
  return intent.wifi.mesh.enabled && intent.wifi.mesh.band === band && band === "5g" ? String(Math.min(80, Number(width))) : width;
};

/** Why these Wi-Fi settings may not be: an SSID broadcast now would be on no band. */
export const strandedReason = (intent: Intent, wifi: WifiSettings) => {
  const stranded = intent.wifi.networks.find((w) => broadcastBands(intent.wifi, w).length && !broadcastBands(wifi, w).length);
  return stranded && `“${stranded.ssid || "Unnamed"}” would be broadcast nowhere: give it another band first (${where("ssids")}).`;
};

/** A channel's centre frequency (MHz), as OpenWrt's wifi-detect counts them. */
const centreOf = (band: Band, channel: number) =>
  band === "2g" ? (channel === 14 ? 2484 : 2407 + 5 * channel) : band === "5g" ? 5000 + 5 * channel : 5950 + 5 * channel;

/**
 * Whether an access point may use a channel (its 20 MHz) in a country, by
 * wireless-regdb (regdb.ts, generated): the kernel holds hostapd to the same
 * table, so a channel outside it leaves the radio down. A country the table
 * lacks: no limit known.
 */
export const channelLegal = (country: string, band: Band, channel: number) => {
  const ranges = regdb[country];
  if (!ranges) return true;
  const centre = centreOf(band, channel);
  return ranges.some(([start, end]) => start <= centre - 10 && centre + 10 <= end);
};

/** Why a channel cannot be used in the intent's country, if it cannot. */
export const illegalChannelReason = (country: string, band: Band, channel: number | "auto" | undefined) =>
  typeof channel === "number" && !channelLegal(country, band, channel)
    ? `Channel ${channel} (${bandLabels[band]}) is not allowed in ${country}: the radio would not start.`
    : undefined;
