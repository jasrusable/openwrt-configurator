// What each Wi-Fi setting is called and does, for people (fields.ts): its
// numbers come from where the compiler takes them (compile.ts, airtime.ts,
// roaming.ts).
import type { FieldInfo } from "../feature";
import { where } from "../places";
import { bandLabels, bands, radios } from "../radios";
import { aqlLimits, txpower } from "./constants";
import { describePrefer5g, describeSteering, describeSteeringLevels, steeringLabels } from "./roaming";

/** AQL's limits (µs) as milliseconds: [2000, 4000] → "2–4 ms". */
const ms = ([low, high]: readonly [number, number]) => `${low / 1000}–${high / 1000} ms`;

export const wifiFields: FieldInfo[] = [
  { path: "wifi", label: "Wi-Fi" },
  { path: "wifi.networks.*", label: (w) => `“${w?.ssid || "unnamed"}”` },
  {
    path: "wifi.networks.*.ssid",
    label: "Name",
    description: "Devices will have to join the network again under its new name.",
  },
  {
    path: "wifi.networks.*.password",
    label: "Password",
    secret: true,
    description: "Devices will have to join again with the new password.",
  },
  {
    path: "wifi.networks.*.extra_passwords",
    label: "More passwords",
    description: "Each works on its own, e.g. one per person.",
    secret: true,
    openwrt: "wifi-station keys (multi-PSK)",
    explain:
      "More passwords for the same SSID, each with the same access. Hand one out (to a guest, a smart plug) and remove it later without changing the main one. WPA2 only: WPA3 allows a single password.",
  },
  { path: "wifi.networks.*.enabled", label: "Enabled", description: "Off: kept here, but no access point broadcasts it." },
  {
    path: "wifi.networks.*.security",
    label: "Security",
    description: "WPA3 is stronger; WPA2/WPA3 lets older devices still join.",
    openwrt: "wifi-iface encryption: psk2, sae-mixed, sae",
    explain:
      "WPA2/WPA3 lets newer devices use WPA3 (SAE) while older ones use WPA2. WPA3 only is the most secure but locks out older devices. WPA3 always brings protected management frames.",
  },
  { path: "wifi.networks.*.hidden", label: "Hidden", description: "Not announced; devices must be told the name." },
  {
    path: "wifi.networks.*.roaming.assisted",
    label: "Roaming assistance",
    description: "Neighbour lists help devices find a better access point.",
    openwrt: "802.11k/v · usteer ssid_list",
    explain: (intent, [i]) => {
      const level = intent.wifi.roaming?.steering ?? "advise";
      const base =
        "Access points tell devices about their neighbours (802.11k) and can suggest a better one (802.11v), with usteer sharing what each access point sees.";
      return level !== "off" && intent.wifi.networks?.[Number(i)]?.roaming.assisted === false
        ? `${base} Off for this SSID: no neighbour lists, and steering (${where("roaming")}) leaves its devices alone.`
        : `${base} Steering is ${steeringLabels[level]} (${where("roaming")}): ${describeSteering(level)}`;
    },
  },
  {
    path: "wifi.networks.*.roaming.fast",
    label: "Fast roaming",
    description: "Seamless handover between access points.",
    openwrt: "802.11r (fast transition)",
    explain:
      "Moving between access points takes milliseconds instead of a full reconnect, so calls do not drop. A few old devices cannot join an SSID with it on; turn it off if one will not connect.",
  },
  { path: "wifi.networks.*.bands", label: "Bands" },
  {
    path: "wifi.networks.*.isolate_clients",
    label: "Isolate clients",
    description: "Its devices cannot reach each other on the same access point.",
    openwrt: "wifi-iface isolate, bridge_isolate",
    explain:
      "Devices on this SSID cannot reach each other on the same access point (across its bands and its other isolated SSIDs too), only the internet and what the network's access allows. Good for guests. Devices on different access points, or wired, still can: every cable carries every network.",
  },
  { path: "wifi.radios", label: "Radios" },
  { path: "wifi.roaming", label: "Roaming" },
  {
    path: "wifi.roaming.steering",
    label: "Steering",
    description: "How firmly access points move devices to a better access point or band.",
    openwrt: "usteer roam_trigger_snr, aggressiveness, min_snr",
    explain: describeSteeringLevels,
  },
  {
    path: "wifi.roaming.prefer_5g",
    label: "Prefer 5 GHz",
    description: "Moves strong dual-band devices off 2.4 GHz.",
    openwrt: "usteer band steering",
    explain: (intent) => describePrefer5g(intent.wifi.roaming?.steering ?? "advise"),
  },

  ...bands.map((band): FieldInfo => ({ path: `wifi.radios.${band}`, label: bandLabels[band] })),
  { path: "wifi.radios.*.enabled", label: "Enabled" },
  {
    path: "wifi.radios.*.width",
    label: "Channel width",
    openwrt: "wifi-device htmode (EHT, HE, VHT or HT)",
    explain: `Wider channels are faster, but there are fewer of them, so they overlap neighbours more. Auto is ${radios
      .map((r) => `${r.width} MHz on ${bandLabels[r.band]}`)
      .join(", ")}, at the newest standard each radio supports (Wi-Fi 7, 6, 5 or 4).`,
  },
  {
    path: "wifi.radios.*.power",
    label: "Transmit power",
    openwrt: "wifi-device txpower",
    explain:
      `Auto transmits at the most your country allows. Low, Medium and High are ${txpower.low}, ${txpower.medium} and ${txpower.high} dBm, still capped by the country's limit.`,
  },
  {
    path: "wifi.radios.*.cell_density",
    label: "Cell density",
    openwrt: "wifi-device cell_density",
    explain:
      "Raises the slowest data rate devices may use, so slow, distant devices cannot hold the air for long. Normal, High and Very high are OpenWrt's levels 1 to 3; Off allows the slowest legacy rates.",
  },
  {
    path: "wifi.radios.*.avoid_radar",
    label: "Avoid radar channels",
    description: "An automatic channel never needs a radar check before it starts.",
    openwrt: "wifi-device acs_exclude_dfs",
    explain:
      "On 5 GHz, channels shared with radar (DFS) make a radio listen for 60 seconds before each start (10 minutes on weather-radar channels), so Wi-Fi is gone for that long after every restart, and some radios fail to start on them. With this on, an automatic channel is picked from the rest (36-48 and 149-165 in most countries); fewer channels to spread over. A channel pinned per device in Hardware is kept as it is.",
  },
  {
    path: "wifi.radios.*.airtime",
    label: "Airtime",
    description: "What the band's Wi-Fi queues favour: latency, balance or throughput.",
    openwrt: "AQL, aql_txq_limit",
    explain:
      `How much each radio queues per device, in airtime. Low latency queues little (${ms(aqlLimits.latency)}), keeping calls responsive while someone downloads; Throughput queues more (${ms(aqlLimits.throughput)}) to keep the air full; Balanced is the kernel's ${ms(aqlLimits.balanced)}.`,
  },
  {
    path: "wifi.networks.*.network",
    label: "Network",
    description: "Devices that join this Wi-Fi land on that network.",
  },
];
