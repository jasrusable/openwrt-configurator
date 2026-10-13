// Wi-Fi › Radios › <band> › Airtime: each radio's queue limits, which
// OpenWrt has no setting for, written by a hook as each radio comes up.
import { Feature, onAccessPoints } from "../fragment";
import { bands } from "../radios";
import { aqlLimits } from "./constants";

export const airtime: Feature = (intent) => {
  // Tightest first: a phy serving several bands (one wiphy, several
  // radios) has one queue limit, and the first of its bands listed wins.
  const entries = bands
    .filter((band) => intent.wifi.radios[band].enabled)
    .map((band) => [band.toUpperCase(), ...aqlLimits[intent.wifi.radios[band].airtime]] as const)
    .sort((a, b) => a[1] - b[1]);
  const [, low, high] = entries[0] ?? ["", ...aqlLimits.balanced];
  return {
    files: [
      {
        when: onAccessPoints,
        path: "/etc/hotplug.d/net/20-aql",
        mode: "0755",
        // Each phy's bands are in board.json, put there by OpenWrt's own
        // Wi-Fi detection; a phy missing from it gets the tightest.
        content: `#!/bin/sh
[ "$ACTION" = "add" ] || exit 0
case "$INTERFACE" in phy*-ap*|wlan*) ;; *) exit 0 ;; esac
for dir in /sys/kernel/debug/ieee80211/phy*; do
  [ -e "$dir/aql_txq_limit" ] || continue
  phy=$(basename "$dir")
  limits="${low} ${high}"
  for entry in ${entries.map((e) => `"${e.join(" ")}"`).join(" ")}; do
    set -- $entry
    jsonfilter -i /etc/board.json -e "@.wlan[\\"$phy\\"].info.bands[\\"$1\\"]" >/dev/null 2>&1 || continue
    limits="$2 $3"
    break
  done
  for ac in 0 1 2 3; do echo "$ac $limits" > "$dir/aql_txq_limit"; done
done
`,
        // Now, when the file changed: it sets every phy whenever it runs, and
        // an interface made later runs it itself (hotplug), so not every apply.
        runAfter: "ACTION=add INTERFACE=phy1-ap0 sh /etc/hotplug.d/net/20-aql",
      },
    ],
  };
};
