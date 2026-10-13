// What the mesh may be, given the rest, and what it holds the radios and
// devices to: its band on, its channel radar-free and everyone's, a node
// reached over it only once it is on.
import type { Choice, ChoiceAt } from "../feature";
import { where } from "../places";
import { bandLabels, illegalChannelReason, meshBands, meshChannels, strandedReason } from "../radios";

/** A mesh key: 32 random letters and digits, from the platform's strong random source. */
export const newMeshKey = () => {
  const alphabet = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
};

/** Every mesh node is on the mesh's channel: one access point elsewhere would drop out of it. */
const meshChannelRule = <B extends "2g" | "5g">(band: B): ChoiceAt<`hardware.*.radios.${B}.channel`> => ({
  path: `hardware.*.radios.${band}.channel`,
  unavailable: (intent) =>
    intent.wifi.mesh.enabled && band === intent.wifi.mesh.band && `Set by the mesh (${where("mesh")}): every node uses its channel.`,
  refuses: false,
});

export const meshRules: Choice[] = [
  {
    // The mesh's channel, one the country allows: every node would fail to start it.
    path: "wifi.mesh.channel",
    values: [...new Set(Object.values(meshChannels).flat())],
    unavailable: (intent, _, channel) =>
      intent.wifi.mesh.enabled && illegalChannelReason(intent.system.country, intent.wifi.mesh.band, channel),
  },
  {
    // 160 MHz on 5 GHz spans 36 to 64, radar channels among them: a radar
    // would move the access point off the mesh's channel.
    path: "wifi.radios.*.width",
    values: ["160"],
    unavailable: (intent, [band]) =>
      intent.wifi.mesh?.enabled &&
      intent.wifi.mesh.band === band &&
      band === "5g" &&
      `The mesh keeps to channels without radar (${where("mesh")}): 80 MHz at most.`,
    // Capped at 80 by the compiler meanwhile.
    refuses: false,
  },
  {
    // The mesh carries everything between its nodes on one radio band.
    path: "wifi.mesh.enabled",
    values: [true],
    unavailable: (intent) =>
      !intent.wifi.radios[intent.wifi.mesh.band]?.enabled &&
      `The ${bandLabels[intent.wifi.mesh.band]} radios are off (${where("radios")}).`,
    // Turning it on makes its key: every node must have the same, and nobody types it.
    swap: (intent) =>
      intent.wifi.mesh.key
        ? undefined
        : {
            note: "Makes a key the access points share.",
            apply: (next) => ({ ...next, wifi: { ...next.wifi, mesh: { ...next.wifi.mesh, enabled: true, key: newMeshKey() } } }),
          },
  },
  {
    path: "wifi.mesh.band",
    values: [...meshBands],
    unavailable: (intent, _, band) =>
      intent.wifi.mesh.enabled && !intent.wifi.radios[band]?.enabled && `The ${bandLabels[band]} radios are off.`,
    // Each band has its own channels: the channel moves with it.
    swap: (intent, _, band) => {
      const channels = meshChannels[band];
      return channels.includes(intent.wifi.mesh.channel)
        ? undefined
        : {
            note: `Moves the mesh to channel ${channels[0]}.`,
            apply: (next) => ({ ...next, wifi: { ...next.wifi, mesh: { ...next.wifi.mesh, band: band, channel: channels[0] } } }),
          };
    },
  },
  {
    path: "wifi.radios.*.enabled",
    values: [false],
    unavailable: (intent, [band]) =>
      intent.wifi.mesh.enabled &&
      intent.wifi.mesh.band === band &&
      `The mesh links your access points on this band (${where("mesh")}): turn it off, or move it, first.`,
  },
  {
    // An SSID only on the mesh's band would be broadcast nowhere.
    path: "wifi.mesh.band_reserved",
    values: [true],
    unavailable: (intent) => strandedReason(intent, { ...intent.wifi, mesh: { ...intent.wifi.mesh, band_reserved: true } }),
    // The schema reports an SSID on no band.
    refuses: false,
  },
  {
    // With the band the mesh's alone, moving or starting the mesh can leave an SSID nowhere too.
    path: "wifi.mesh.enabled",
    values: [true],
    unavailable: (intent) => strandedReason(intent, { ...intent.wifi, mesh: { ...intent.wifi.mesh, enabled: true } }),
    refuses: false,
  },
  {
    path: "wifi.mesh.band",
    values: [...meshBands],
    unavailable: (intent, _, band) => strandedReason(intent, { ...intent.wifi, mesh: { ...intent.wifi.mesh, band: band } }),
    refuses: false,
  },
  {
    // Only over cables: the Wi-Fi links always take them.
    path: "wifi.mesh.large_frames",
    unavailable: (intent) => !intent.wifi.mesh?.over_cable && "Only for the mesh over cables.",
    refuses: false,
  },
  {
    // Kept for when the mesh is back; until then every device is cabled (hardware/compile.ts).
    path: "hardware.*.uplink",
    values: ["mesh"],
    unavailable: (intent) => !intent.wifi.mesh.enabled && `Turn on the mesh first (${where("mesh")}).`,
    refuses: false,
  },
  meshChannelRule("2g"),
  meshChannelRule("5g"),
];
