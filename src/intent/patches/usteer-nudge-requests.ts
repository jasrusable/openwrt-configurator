import { Patch } from "./patch";

export const usteerNudgeRequests: Patch = {
  id: "usteer-nudge-requests",
  title: "Nudge never disconnects on 25.12's usteer",
  required: true,
  why:
    "25.12 ships usteer 2025.10.04, from before its `aggressiveness` option: a move request is " +
    "always followed by a disconnect after roam_kick_delay, so Nudge (ask, never disconnect) " +
    "would disconnect fading devices after 10 s, as Push does, IoT devices included. Where " +
    "Steering is Nudge, the move trigger is off there: usteer still shares neighbour lists and " +
    "asks devices what they see, and never disconnects them.",
  kind: "fix",
  references: [
    { kind: "commit", url: "https://github.com/openwrt/usteer/commit/49ba5f18", note: "policy: steering with levels of aggressiveness (2026-05-19), not in 25.12's usteer" },
    { kind: "docs", url: "https://github.com/openwrt/packages/tree/openwrt-25.12/net/usteer", note: "25.12 pins usteer 2025.10.04 (1d6524c6)" },
  ],
  added: "2026-10-13",
  verified: "25.12.5's usteer package: its init script has no aggressiveness option",
  dropWhen: "devices run a release whose usteer has aggressiveness (packages master: the release after 25.12)",
  target: { roles: ["access-point"], releases: { from: "25.12.0", before: "26.0" } },
  applies: (intent) => intent.wifi.roaming.steering === "nudge",
  note: "On OpenWrt 25.12, whose usteer cannot ask without disconnecting, Nudge only shares neighbour lists and asks devices what they see",
  apply: () => ({ amend: [{ config: "usteer", type: "usteer", options: { roam_trigger_snr: "0" } }] }),
};
