import { when } from "../../plan/when";
import type { Section } from "../../plan/types";
import type { Intent } from "../schema";
import { amendOf, Patch } from "./patch";

type Ssid = Intent["wifi"]["networks"][number];

/**
 * Where the race hurts: fast roaming with WPA3 (SAE, alone or beside WPA2).
 * On WPA2 the failure is mostly noise in the log; the long disconnects are
 * reported with SAE. Decided by each section's encryption, as compiled: an
 * SSID's 6 GHz section is SAE whatever its security (6 GHz allows nothing else).
 */
const atRisk = ({ item, section }: { item: Ssid; section: Section }) =>
  item.roaming.fast && /^sae/.test(String(section.options.encryption));

/** Whether any SSID has such a section: WPA3 in its security, or broadcast on 6 GHz (the mesh's spare radio there too). */
const anyAtRisk = (intent: Intent) =>
  intent.wifi.networks.some(
    (ssid) =>
      ssid.roaming.fast &&
      (ssid.security !== "wpa2" || (intent.wifi.radios["6g"].enabled && (!ssid.bands || ssid.bands.includes("6g"))))
  );

export const ftKeyRace: Patch = {
  id: "ft-key-race",
  title: "Fast roaming held off with WPA3 on OpenWrt 25.12",
  why:
    "With fast roaming (802.11r), hostapd hands the kernel a roaming client's key before " +
    "mac80211 marks it associated; the kernel refuses it ('key addition failed') and a retry " +
    "sometimes fails too. In mac80211, so on every driver (seen on MT7981 and ath10k); unfixed " +
    "in every 25.12 release. With WPA2 the roam still completes (the user's access point: 35 " +
    "failures in 11.5 h, 33 with no full reconnect after), so it is mostly noise in the log; the " +
    "multi-minute disconnects are reported with WPA3 and WPA2/WPA3, and 802.11r also stops some " +
    "older clients joining WPA3 at all. So it is held off where an SSID uses WPA3 (on 6 GHz, " +
    "which allows nothing else, included), until a release " +
    "has the fix: 802.11k/v and steering keep working, a roam just takes 10-50 ms longer. The " +
    "setting is kept, and its explainer says so.",
  kind: "fix",
  references: [
    { kind: "pr", url: "https://github.com/openwrt/openwrt/pull/23181", note: "mac80211: defer AP-side FT key upload until station association (open)" },
    { kind: "issue", url: "https://github.com/openwrt/mt76/issues/1098", note: "MT7981 (Cudy WR3000S): multi-minute disconnects during FT roaming, persists on 25.12.5" },
    { kind: "issue", url: "https://github.com/openwrt/openwrt/issues/9071", note: "the same kernel race, ath10k" },
    { kind: "forum", url: "https://forum.openwrt.org/t/802-11r-iphone-can-not-connect/150643", note: "iPhones that cannot join with 802.11r" },
    { kind: "forum", url: "https://forum.openwrt.org/t/wpa3-personal-only-and-802-11r-ft/93810", note: "WPA3 with FT and older clients" },
  ],
  added: "2026-10-13",
  verified:
    "user's NWA50AX Pro, 25.12.5, 2026-10-13: 35 failures in 11.5 h, 33 without a following full reconnect, WPA2; " +
    "the WPA3 disconnects from openwrt#23181 and mt76#1098; the override checked in the compiled config (patches.test.ts)",
  dropWhen: "an OpenWrt release carries the fix (openwrt#23181)",
  target: {
    releases: { from: "25.12.0" },
    requires: { when: when.any(when.radio("2g"), when.radio("5g"), when.radio("6g")), note: "has Wi-Fi" },
  },
  applies: anyAtRisk,
  note: "Held off with WPA3 on OpenWrt 25.12, where it can cut roaming clients off for minutes, until a release has the fix; the setting is kept for then",
  apply: () => ({
    amend: [amendOf("wifi.networks.*", { config: "wireless", type: "wifi-iface", where: atRisk, options: { ieee80211r: false } })],
  }),
};
