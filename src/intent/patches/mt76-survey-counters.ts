import { amendOf, Patch } from "./patch";

export const mt76SurveyCounters: Patch = {
  id: "mt76-survey-counters",
  title: "Channel load not advertised on the NWA50AX Pro",
  affects: [],
  why:
    "mt7915/mt7981's survey counters underflow after two to three days, so the channel use " +
    "hostapd advertises in each beacon (BSS Load) freezes at a bogus high value on 5 GHz, and " +
    "clients that weigh it pick 2.4 GHz instead. The element is turned off where the driver " +
    "has the bug; the app's own survey treats such counters as unknown (status/actions.ts).",
  kind: "fix",
  references: [
    { kind: "issue", url: "https://github.com/openwrt/mt76/issues/1135", note: "GET_MIB_INFO survey counters underflow; BSS Load freezes at a bogus value" },
    { kind: "report", url: "https://github.com/openwrt/mt76/issues/1135", note: "filed from the user's NWA50AX Pro, where 5 GHz clients moved to 2.4 GHz" },
  ],
  added: "2026-10-13",
  verified: "the user's NWA50AX Pro on 25.12.5 (the bug, and that hostapd's BSS Load stops with both periods 0)",
  dropWhen: "an OpenWrt release carries the fix for mt76#1135",
  // Seen on this model; other mt7915/mt7981 boards likely share it (the
  // driver's), added as they are confirmed.
  target: { models: ["zyxel,nwa50ax-pro"], roles: ["access-point"] },
  apply: () => ({
    amend: [
      // Every SSID (access-point interfaces), never the mesh's or the rescue's.
      amendOf("wifi.networks.*", { config: "wireless", type: "wifi-iface", options: { bss_load_update_period: "0", chan_util_avg_period: "0" } }),
    ],
  }),
};
