// Wi-Fi, from the access points: every network on every band, with fast
// roaming between access points. Radios are matched to bands on the device;
// the intent only ever says which channel, if any, to pin.
import { Feature, mainNetwork, onAccessPoints, onDevice } from "../fragment";
import { timezones } from "../timezones";

const bands = [
  { band: "2g", name: "radio0", htmode: "HE20" },
  { band: "5g", name: "radio1", htmode: "HE80" },
] as const;

export const wifi: Feature = (intent) => {
  const posixTimezone = timezones[intent.site.timezone];
  const isolated = (id: string) =>
    !!intent.networks.find((n) => n.id === id)?.isolate_clients;
  const ap = (section: Record<string, unknown>) => ({
    ".if": onAccessPoints,
    ...section,
  });
  return {
    package_profiles: [
      {
        ".if": onAccessPoints,
        // The full wpad, for 802.11r; usteer steers clients between APs.
        packages: [
          "-wpad-basic-mbedtls",
          "wpad-mbedtls",
          "usteer",
          "luci-app-usteer",
        ],
      },
    ],
    config: {
      wireless: {
        "wifi-device": bands.map(({ band, name, htmode }) =>
          ap({
            ".name": name,
            band,
            htmode,
            channel: "auto",
            cell_density: 1,
            country: intent.site.country,
            ".overrides": intent.devices.flatMap((device) => {
              const channel = device.wifi?.channel?.[band];
              return channel !== undefined
                ? [{ ".if": onDevice(device.name), override: { channel } }]
                : [];
            }),
          })
        ),
        "wifi-iface": intent.wifi.map((network) =>
          ap({
            mode: "ap",
            device: bands.map(({ name }) => name),
            network: network.network,
            // hostapd's isolation: only within this access point's BSS. Across
            // access points, bands or wired ports it needs bridge port
            // isolation too (TODO.md).
            ...(isolated(network.network) ? { isolate: true } : {}),
            ssid: network.ssid,
            encryption: "psk2+ccmp",
            key: network.password,
            ...(network.extra_passwords?.length
              ? { stations: network.extra_passwords.map((key) => ({ key })) }
              : {}),
            // Fast roaming between access points (802.11r/k/v).
            ieee80211r: true,
            ieee80211k: true,
            bss_transition: true,
            ft_over_ds: false,
            time_advertisement: 2,
            time_zone: posixTimezone,
            max_inactivity: 3600,
            disassoc_low_ack: false,
            bss_load_update_period: "0",
            chan_util_avg_period: "0",
          })
        ),
      },
      usteer: {
        usteer: [
          ap({
            ".name": "usteer",
            // Access points coordinate over the main network.
            network: mainNetwork(intent).id,
            syslog: "1",
            debug_level: "1",
            assoc_steering: "0",
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
          }),
        ],
      },
    },
  };
};
