// Wi-Fi, from the access points: each SSID on its bands, with fast roaming
// between access points, and each band's radios set as Wi-Fi › Radios says.
// Radios are matched to bands on the device, so a band an access point lacks
// (6 GHz on most) is skipped there; the intent only pins channels per device.
import { Feature, mainNetwork, onAccessPoints, onDevice, serviceWhen } from "../fragment";
import { uniqueNames } from "../names";
import { Band, Intent } from "../schema";
import {
  bandSteering,
  betterBy,
  floorForMs,
  moveWithinMs,
  steeredSsids,
  steeringValues,
  takesPart,
} from "../roaming";
import { timezones } from "../timezones";

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

/** dBm. The driver still caps it at what the country allows. */
const txpower = { low: 10, medium: 15, high: 20 } as const;
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
  const ap = (section: Record<string, unknown>) => ({
    ".if": onAccessPoints,
    ...section,
  });
  const enabled = radios.filter(({ band }) => intent.wifi.radios[band].enabled);
  const ssidNames = uniqueNames("wifi", intent.wifi.networks, (ssid) => ssid.ssid);
  const meshBand = intent.wifi.mesh.enabled ? intent.wifi.mesh.band : undefined;
  const dedicatedBand = intent.wifi.mesh.enabled && intent.wifi.mesh.band_reserved ? intent.wifi.mesh.band : undefined;

  return {
    package_profiles: [
      {
        ".if": onAccessPoints,
        // The full wpad, for 802.11r and WPA3; usteer steers clients between APs.
        packages: ["-wpad-basic-mbedtls", "wpad-mbedtls", "usteer", "luci-app-usteer"],
      },
    ],
    services: [
      { ".if": onAccessPoints, name: "wpad", running: true },
      serviceWhen(onAccessPoints, "usteer", steeredSsids(intent).length > 0),
    ],
    config: {
      wireless: {
        "wifi-device": radios.map(({ band, name, width }) => {
          const settings = intent.wifi.radios[band];
          return ap({
            ".name": name,
            band,
            ...(settings.enabled ? {} : { disabled: true }),
            // The best the radio can do at this width: Wi-Fi 7, 6, 5 or 4.
            // The mesh's band at most 80 MHz: wider reaches radar channels.
            htmode: `@best/${radioWidth(intent, band)}`,
            // The mesh's band: every node on its channel, pinned or not.
            channel: meshBand === band ? intent.wifi.mesh.channel : "auto",
            cell_density: cellDensity[settings.cell_density],
            ...(settings.power === "auto" ? {} : { txpower: txpower[settings.power] }),
            country: intent.system.country,
            ".overrides": intent.hardware.flatMap((device) => {
              if (meshBand === band) return [];
              const channel = (device.radios as Record<string, { channel?: unknown } | undefined> | undefined)?.[band]?.channel;
              return channel !== undefined
                ? [{ ".if": onDevice(device.name), override: { channel } }]
                : [];
            }),
          });
        }),
        "wifi-iface": intent.wifi.networks.flatMap((ssid, i) => {
          // Not the mesh's band when it has it to itself.
          const on = enabled.filter(
            ({ band }) => (!ssid.bands || ssid.bands.includes(band)) && !(dedicatedBand === band)
          );
          const common = {
            // Named by the SSID, per radio (the engine adds the radio), so
            // adding or removing another SSID renames none of these.
            ".name": ssidNames[i],
            mode: "ap",
            network: ssid.network,
            ssid: ssid.ssid,
            ...(ssid.enabled ? {} : { disabled: true }),
            ...(ssid.hidden ? { hidden: true } : {}),
            key: ssid.password,
            ...(ssid.extra_passwords?.length
              ? { stations: ssid.extra_passwords.map((key) => ({ key })) }
              : {}),
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
              ? [ap({ ...common, device: legacy.map((r) => r.name), encryption: encryption[ssid.security] })]
              : []),
            // 6 GHz allows WPA3 (SAE) only.
            ...(sixGhz ? [ap({ ...common, device: [sixGhz.name], encryption: "sae" })] : []),
          ];
        }),
      },
      usteer: {
        usteer: [
          ap({
            ".name": "usteer",
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
