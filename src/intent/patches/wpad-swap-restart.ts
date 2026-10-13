import { when } from "../../plan/when";
import { Patch } from "./patch";

export const wpadSwapRestart: Patch = {
  id: "wpad-swap-restart",
  title: "wpad restarted when its package changes",
  affects: [],
  why:
    "wpad's init script belongs to hostapd-common and the wpad packages restart nothing when " +
    "installed, so swapping wpad-basic for the full wpad (the mesh, 802.11k/v) leaves the old " +
    "binary running until a reboot. Restarted inside the confirm window when a run swaps it.",
  kind: "fix",
  references: [
    { kind: "issue", url: "https://github.com/openwrt/openwrt/issues/23565", note: "a maintainer: reboot after replacing wpad; wifi down/up is not enough" },
    { kind: "docs", url: "https://github.com/openwrt/openwrt/blob/v25.12.5/package/network/services/hostapd/Makefile", note: "the wpad packages' install scripts" },
  ],
  added: "2026-10-13",
  verified: "the restart record in the run's services step (patches.test.ts, provisionNetwork's records); not on a radio (Docker has none)",
  dropWhen: "the wpad packages restart wpad on install",
  target: { requires: { when: when.any(when.radio("2g"), when.radio("5g"), when.radio("6g")), note: "has Wi-Fi" } },
  apply: () => ({ restarts: [{ service: "wpad", after: "package-change", packages: ["wpad*"] }] }),
};
