// Wi-Fi, from the access points: each SSID on its bands, with fast roaming
// between access points, and each band's radios set as Wi-Fi › Radios says.
// Radios are matched to bands on the device, so a band an access point lacks
// (6 GHz on most) is skipped there; the intent only pins channels per device.
import { Feature, mainNetwork, onAccessPoints, onDevice, serviceWhen } from "../fragment";
import { Options, placeholder, section, SectionMeta, Value } from "../../plan/types";
import { uniqueNames } from "../names";
import { broadcastBands, radios, radioWidth } from "../radios";
import type { Band } from "../radios";
import type { Intent } from "../schema";
import {
  bandSteering,
  betterBy,
  floorForMs,
  moveWithinMs,
  steeredSsids,
  steeringValues,
  takesPart,
} from "./roaming";
import { timezones } from "../system";
import { txpower } from "./constants";

const cellDensity = { off: 0, normal: 1, high: 2, very_high: 3 } as const;

/** OpenWrt's encryption, by security mode; PMF follows (optional in mixed, required in WPA3). */
const encryption = { wpa2: "psk2+ccmp", "wpa2-wpa3": "sae-mixed", wpa3: "sae" } as const;

/**
 * usteer's steering, from Wi-Fi › Roaming, with the values in roaming.ts
 * (which the explainers quote). Nothing moves a device until its signal
 * drops below roam_scan_snr; aggressiveness is always set, since its default
 * (3: disconnect after the request) would also apply to band moves.
 * roam_kick_delay is also how long a move request stays open, so it must not
 * be 0 while steering.
 */
const steering = ({ steering, prefer_5g }: Intent["wifi"]["roaming"]) => {
  const level = steeringValues[steering];
  const moves = steering === "nudge" || steering === "push";
  return {
    aggressiveness: String(level.aggressiveness),
    signal_diff_threshold: String(betterBy),
    roam_scan_snr: String(level.scanBelow),
    roam_trigger_snr: String(level.moveBelow),
    roam_kick_delay: moves || prefer_5g ? String(moveWithinMs) : "0",
    min_snr: String(level.floor),
    ...(level.floor ? { min_snr_kick_delay: String(floorForMs) } : {}),
    band_steering_interval: prefer_5g ? String(bandSteering.forMs) : "0",
    ...(prefer_5g ? { band_steering_min_snr: String(bandSteering.strongerThan) } : {}),
  };
};

export const wifi: Feature = (intent) => {
  const posixTimezone = timezones[intent.system.timezone];
  const ap = (meta: SectionMeta, options: Record<string, Value | undefined>) =>
    section({ ...meta, when: onAccessPoints }, options);
  const ssidNames = uniqueNames("wifi", intent.wifi.networks, (ssid) => ssid.ssid);
  const meshBand = intent.wifi.mesh.enabled ? intent.wifi.mesh.band : undefined;

  return {
    packages: [
      {
        when: onAccessPoints,
        // The full wpad, for 802.11r and WPA3; usteer steers clients between APs.
        add: ["wpad-mbedtls", "usteer", "luci-app-usteer"],
        remove: ["wpad-basic-mbedtls"],
      },
    ],
    services: [
      { when: onAccessPoints, name: "wpad", running: true },
      serviceWhen(onAccessPoints, "usteer", steeredSsids(intent).length > 0),
    ],
    config: {
      wireless: {
        "wifi-device": radios.map(({ band, name, width }) => {
          const settings = intent.wifi.radios[band];
          // A channel pinned per device, except on the mesh's band (the mesh's own).
          const pinned = intent.hardware.flatMap((device) => {
            // Pinned in the bands Hardware offers it for (no 6 GHz).
            const pins: Partial<Record<Band, { channel?: number | "auto" }>> = device.radios ?? {};
            const channel = meshBand === band ? undefined : pins[band]?.channel;
            return channel !== undefined ? [{ when: onDevice(device.name), options: { channel } as Options }] : [];
          });
          return ap(
            { name, overrides: pinned },
            {
              band,
              ...(settings.enabled ? {} : { disabled: true }),
              // The best the radio can do at this width: Wi-Fi 7, 6, 5 or 4.
              // The mesh's band at most 80 MHz: wider reaches radar channels.
              htmode: placeholder.bestMode(Number(radioWidth(intent, band))),
              // The mesh's band: every node on its channel, pinned or not.
              channel: meshBand === band ? intent.wifi.mesh.channel : "auto",
              cell_density: cellDensity[settings.cell_density],
              ...(settings.power === "auto" ? {} : { txpower: txpower[settings.power] }),
              country: intent.system.country,
            }
          );
        }),
        "wifi-iface": intent.wifi.networks.flatMap((ssid, i) => {
          const on = radios.filter(({ band }) => broadcastBands(intent.wifi, ssid).includes(band));
          // Named by the SSID, per radio (the engine adds the radio), so
          // adding or removing another SSID renames none of these.
          const name = ssidNames[i];
          const common = {
            mode: "ap",
            network: ssid.network,
            ssid: ssid.ssid,
            ...(ssid.enabled ? {} : { disabled: true }),
            ...(ssid.hidden ? { hidden: true } : {}),
            key: ssid.password,
            ...(ssid.extra_passwords?.length ? { stations: placeholder.stations(ssid.extra_passwords) } : {}),
            // hostapd's isolation: within this access point and band only.
            ...(ssid.isolate_clients ? { isolate: true } : {}),
            // Roaming: neighbour reports (k, filled in by usteer) and
            // transition management (v) let a client pick the next access
            // point itself; fast handover (r) makes the move seamless.
            // OpenWrt derives the rest: the mobility domain from the SSID,
            // and keys from the password (locally for WPA2, by a shared
            // key-holder for WPA3), the same on every access point; FT over
            // the air.
            ieee80211r: ssid.roaming.fast,
            // Over the air, said rather than left to the default: over the
            // network (DS) trips up some clients.
            ...(ssid.roaming.fast ? { ft_over_ds: false } : {}),
            ieee80211k: takesPart(intent, ssid),
            bss_transition: takesPart(intent, ssid),
            time_advertisement: 2,
            time_zone: posixTimezone,
            max_inactivity: 3600,
            // Group key once a day: fewer rekeys, which some clients drop on.
            wpa_group_rekey: 86400,
            disassoc_low_ack: false,
            bss_load_update_period: "0",
            chan_util_avg_period: "0",
          };
          const legacy = on.filter(({ band }) => band !== "6g");
          const sixGhz = on.find(({ band }) => band === "6g");
          return [
            ...(legacy.length
              ? [ap({ name }, { ...common, device: legacy.map((r) => r.name), encryption: encryption[ssid.security] })]
              : []),
            // 6 GHz allows WPA3 (SAE) only.
            ...(sixGhz ? [ap({ name }, { ...common, device: [sixGhz.name], encryption: "sae" })] : []),
          ];
        }),
      },
      usteer: {
        usteer: [
          ap({ name: "usteer" }, {
            // Stopped when roaming is Off or no SSID takes part: an empty
            // ssid_list would mean every SSID, not none.
            enabled: steeredSsids(intent).length > 0,
            // Access points share what they see over the main network, so
            // each can give clients a list of its neighbours (802.11k reports,
            // via hostapd). Steering (Wi-Fi › Roaming) adds moving them; never
            // refusing a connection, load balancing or probe games.
            network: mainNetwork(intent).id,
            syslog: "1",
            debug_level: "1",
            assoc_steering: "0",
            probe_steering: "0",
            load_balancing_threshold: "0",
            band_steering_threshold: "0",
            ...steering(intent.wifi.roaming),
            load_kick_enabled: "0",
            min_connect_snr: "0",
            initial_connect_delay: "0",
            // Only the SSIDs that give clients neighbour reports.
            ssid_list: steeredSsids(intent).map((ssid) => ssid.ssid),
          }),
        ],
      },
    },
  };
};
