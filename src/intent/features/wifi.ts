// Wi-Fi, from the access points: each SSID on its bands, with fast roaming
// between access points, and each band's radios set as Wi-Fi › Radios says.
// Radios are matched to bands on the device, so a band an access point lacks
// (6 GHz on most) is skipped there; the intent only pins channels per device.
import { Feature, mainNetwork, onAccessPoints, onDevice } from "../fragment";
import { Band } from "../schema";
import { timezones } from "../timezones";

const radios: { band: Band; name: string; width: string }[] = [
  { band: "2g", name: "radio0", width: "20" },
  { band: "5g", name: "radio1", width: "80" },
  { band: "6g", name: "radio2", width: "160" },
];

/** dBm. The driver still caps it at what the country allows. */
const txpower = { low: 10, medium: 15, high: 20 } as const;
const cellDensity = { off: 0, normal: 1, high: 2, very_high: 3 } as const;

/** OpenWrt's encryption, by security mode; PMF follows (optional in mixed, required in WPA3). */
const encryption = { wpa2: "psk2+ccmp", "wpa2-wpa3": "sae-mixed", wpa3: "sae" } as const;

export const wifi: Feature = (intent) => {
  const posixTimezone = timezones[intent.site.timezone];
  const ap = (section: Record<string, unknown>) => ({
    ".if": onAccessPoints,
    ...section,
  });
  const enabled = radios.filter(({ band }) => intent.radios[band].enabled);

  return {
    package_profiles: [
      {
        ".if": onAccessPoints,
        // The full wpad, for 802.11r and WPA3; usteer steers clients between APs.
        packages: ["-wpad-basic-mbedtls", "wpad-mbedtls", "usteer", "luci-app-usteer"],
      },
    ],
    config: {
      wireless: {
        "wifi-device": radios.map(({ band, name, width }) => {
          const settings = intent.radios[band];
          return ap({
            ".name": name,
            band,
            ...(settings.enabled ? {} : { disabled: true }),
            htmode: `HE${settings.width === "auto" ? width : settings.width}`,
            channel: "auto",
            cell_density: cellDensity[settings.cell_density],
            ...(settings.power === "auto" ? {} : { txpower: txpower[settings.power] }),
            country: intent.site.country,
            ".overrides": intent.hardware.flatMap((device) => {
              const channel = (device.wifi?.channel as Record<string, unknown> | undefined)?.[band];
              return channel !== undefined
                ? [{ ".if": onDevice(device.name), override: { channel } }]
                : [];
            }),
          });
        }),
        "wifi-iface": intent.wifi.flatMap((ssid) => {
          const on = enabled.filter(({ band }) => !ssid.bands || ssid.bands.includes(band));
          const common = {
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
            ieee80211r: ssid.fast_roaming,
            ieee80211k: ssid.roaming_assistance,
            bss_transition: ssid.roaming_assistance,
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
            // Passive: access points share what they see over the main
            // network, so each can give clients a list of its neighbours
            // (802.11k reports, via hostapd). Every way of pushing a client
            // somewhere is off: no refusing, kicking, nudging or band moves.
            network: mainNetwork(intent).id,
            syslog: "1",
            debug_level: "1",
            assoc_steering: "0",
            probe_steering: "0",
            load_balancing_threshold: "0",
            band_steering_threshold: "0",
            signal_diff_threshold: "8",
            roam_scan_snr: "0",
            roam_trigger_snr: "0",
            roam_kick_delay: "0",
            load_kick_enabled: "0",
            min_snr: "0",
            min_connect_snr: "0",
            initial_connect_delay: "0",
            band_steering_interval: "0",
            // Only the SSIDs that give clients neighbour reports.
            ssid_list: intent.wifi
              .filter((ssid) => ssid.enabled && ssid.roaming_assistance)
              .map((ssid) => ssid.ssid),
          }),
        ],
      },
    },
  };
};
