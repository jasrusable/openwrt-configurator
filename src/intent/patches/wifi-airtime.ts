import { onAccessPoints } from "../fragment";
import { Patch } from "./patch";

/**
 * Wi-Fi queue limits (AQL, in µs: low and high water mark per access
 * category). Lower keeps less queued in the radio, so a call stays snappy
 * while something downloads; higher fills the air better.
 */
const aqlLimits = {
  balanced: [5000, 12000], // the kernel's own
  latency: [2000, 4000],
  throughput: [8000, 20000],
} as const;

export const wifiAirtime: Patch = {
  id: "wifi-airtime",
  why:
    "OpenWrt has no setting for the radios' queue limits (AQL); Wi-Fi › Radios › Airtime " +
    "picks them, written on every radio as it comes up.",
  when: onAccessPoints,
  apply: (intent) => {
    const [low, high] = aqlLimits[intent.radios.airtime];
    return {
      files: [
        {
            path: "/etc/hotplug.d/net/20-aql",
          mode: "0755",
          content: `#!/bin/sh
[ "$ACTION" = "add" ] || exit 0
case "$INTERFACE" in phy*-ap*|wlan*) ;; *) exit 0 ;; esac
for phy in /sys/kernel/debug/ieee80211/phy*; do
  [ -e "$phy/aql_txq_limit" ] || continue
  for ac in 0 1 2 3; do echo "$ac ${low} ${high}" > "$phy/aql_txq_limit"; done
done
`,
          run_after_reload: "ACTION=add INTERFACE=phy1-ap0 sh /etc/hotplug.d/net/20-aql",
        },
      ],
    };
  },
};
