// What the Wi-Fi settings may be, given the rest: a radio's widths, an
// SSID's bands and passwords, and steering only where there is somewhere to
// steer to.
import type { Choice } from "../feature";
import { where } from "../places";
import { bandLabels, bands, strandedReason } from "../radios";
import { steeringLabels } from "./roaming";

export const wifiRules: Choice[] = [
  {
    path: "wifi.radios.*.avoid_radar",
    values: [true],
    unavailable: (intent, [band]) =>
      band !== "5g"
        ? "Only 5 GHz has radar channels."
        : intent.wifi.mesh.enabled && intent.wifi.mesh.band === "5g" && "The mesh keeps 5 GHz on a radar-free channel already.",
    // Harmless where unavailable: nothing is compiled for it.
    refuses: false,
  },
  {
    path: "wifi.radios.*.width",
    values: ["80", "160"],
    unavailable: (_, [band]) => band === "2g" && "2.4 GHz is at most 40 MHz wide.",
  },
  {
    // Off would leave an SSID that only uses this band broadcasting nowhere.
    path: "wifi.radios.*.enabled",
    values: [false],
    unavailable: (intent, [band]) =>
      strandedReason(intent, { ...intent.wifi, radios: { ...intent.wifi.radios, [band]: { ...intent.wifi.radios[band], enabled: false } } }),
    // The schema reports an SSID on no band.
    refuses: false,
  },
  {
    path: "wifi.networks.*.bands",
    values: ["2g", "5g", "6g"],
    unavailable: (intent, _, band) =>
      !intent.wifi.radios[band]?.enabled &&
      `${bandLabels[band]} radios are off (${where("radios")}).`,
    // The schema reports an SSID none of whose bands is on.
    refuses: false,
  },
  {
    path: "wifi.networks.*.extra_passwords",
    unavailable: (intent, [i]) =>
      intent.wifi.networks[Number(i)]?.security !== "wpa2" &&
      "Only with WPA2: WPA3 has one password per network.",
  },
  {
    path: "wifi.networks.*.security",
    values: ["wpa2-wpa3", "wpa3"],
    unavailable: (intent, [i]) =>
      !!intent.wifi.networks[Number(i)]?.extra_passwords?.length &&
      "It has more passwords, which only WPA2 allows: remove them first.",
    // The extra passwords' own rule reports it.
    refuses: false,
  },
  {
    // usteer moves devices between access points and between bands on one.
    path: "wifi.roaming.steering",
    values: ["nudge", "push"],
    unavailable: (intent) =>
      intent.hardware.filter((d) => d.role === "access-point").length <= 1 &&
      bands.filter((b) => intent.wifi.radios[b]?.enabled).length <= 1 &&
      "One access point with one band on: there is nowhere to steer a device to.",
    // Harmless: with nowhere to go, nothing is steered.
    refuses: false,
  },
  {
    // Off stops usteer and turns neighbour lists off on every SSID.
    path: "wifi.networks.*.roaming.assisted",
    unavailable: (intent) =>
      intent.wifi.roaming?.steering === "off" &&
      `Steering is ${steeringLabels.off} (${where("roaming")}): no SSID gives neighbour lists.`,
    // Ignored meanwhile, and kept for when steering is back on.
    refuses: false,
  },
  {
    path: "wifi.roaming.prefer_5g",
    values: [true],
    unavailable: (intent) =>
      intent.wifi.roaming?.steering === "off" &&
      `Steering is ${steeringLabels.off}: usteer, which moves devices between bands, is stopped.`,
    refuses: false,
  },
  {
    path: "wifi.roaming.prefer_5g",
    values: [true],
    unavailable: (intent) =>
      !(intent.wifi.radios["2g"]?.enabled && (intent.wifi.radios["5g"]?.enabled || intent.wifi.radios["6g"]?.enabled)) &&
      `Needs 2.4 GHz and a faster band on (${where("radios")}).`,
    refuses: false,
  },
];
