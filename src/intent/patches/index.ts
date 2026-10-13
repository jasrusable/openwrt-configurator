// Every patch, in order. Adding a fix for a model, a role or a release is
// adding a file here and a line below; when OpenWrt fixes one upstream, give
// it `releases.before` the fixed release, and drop it once no device runs an
// older one.
import { leasesToRam } from "./leases-to-ram";
import { miniupnpdFirewallReload } from "./miniupnpd-firewall-reload";
import { odhcpdRaRestart } from "./odhcpd-ra-restart";
import type { FeatureModule } from "../feature";
import type { Intent } from "../schema";
import { amendPlan, applyPatches, patchesFor } from "./patch";
import { r6sPacketSteering } from "./r6s-packet-steering";
import { ubihealthdConfig } from "./ubihealthd-config";
import { mt76SurveyCounters } from "./mt76-survey-counters";
import { ftKeyRace } from "./ft-key-race";
import { usteerNudgeRequests } from "./usteer-nudge-requests";
import { nwa50axEeeOff } from "./nwa50ax-eee-off";
import { wpadSwapRestart } from "./wpad-swap-restart";

export const patches = [
  r6sPacketSteering,
  odhcpdRaRestart,
  ubihealthdConfig,
  leasesToRam,
  mt76SurveyCounters,
  ftKeyRace,
  usteerNudgeRequests,
  nwa50axEeeOff,
  wpadSwapRestart,
  miniupnpdFirewallReload,
];

/** A fix turned off must be one, and not one whose absence breaks something silently. */
const checkOff: FeatureModule["check"] = (intent, issue) =>
  (intent.system.patches?.off ?? []).forEach((id, i) => {
    const patch = patches.find((p) => p.id === id);
    if (!patch) issue(["system", "patches", "off", i], "no such fix");
    else if (patch.required) issue(["system", "patches", "off", i], `${patch.title}: this fix cannot be turned off`);
  });

/** Last of every compile step: fixes layered over everything else; and the decision to turn some off. */
export const patchesFeature: FeatureModule = {
  compile: [{ order: 1000, compile: applyPatches(patches) }],
  check: checkOff,
  fields: [
    { path: "system.patches", label: "Fixes" },
    {
      path: "system.patches.off",
      label: "Fixes turned off",
      explain:
        "Fixes this app layers over OpenWrt for known problems, each with its reason and where it was reported; one turned off is left as OpenWrt ships it. Fixes whose absence breaks something silently cannot be turned off.",
    },
  ],
};

/** The plan with every needed patch's amends (after every feature's sections are in). */
export const withPatchAmends = amendPlan(patches);

/**
 * Which patches each device gets, one line per device, then each patch's
 * reason to read and when it goes: for the CLI (`compile`'s stderr).
 */
export const describePatches = (intent: Intent) => {
  const perDevice = patchesFor(patches, intent);
  const used = [...new Map(perDevice.flatMap((d) => d.patches).map((p) => [p.id, p])).values()];
  return [
    "Patches over OpenWrt (src/intent/patches):",
    ...perDevice.map(
      ({ device, patches }) =>
        `  ${device}: ${patches.map(({ id, only }) => (only ? `${id} (${only})` : id)).join(", ") || "none"}`
    ),
    ...used.flatMap(({ id, references, dropWhen }) => [
      `  ${id}: drop when ${dropWhen}`,
      ...references.map((r) => `    ${r.kind}: ${r.url}${r.note ? ` (${r.note})` : ""}`),
    ]),
  ].join("\n");
};