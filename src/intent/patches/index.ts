// Every patch, in order. Adding a fix for a model, a role or a release is
// adding a file here and a line below; when OpenWrt fixes one upstream, give
// it `releases.before` the fixed release, and drop it once no device runs an
// older one.
import { leasesToRam } from "./leases-to-ram";
import { odhcpdRaRestart } from "./odhcpd-ra-restart";
import type { FeatureModule } from "../feature";
import type { Intent } from "../schema";
import { applyPatches, patchesFor } from "./patch";
import { r6sPacketSteering } from "./r6s-packet-steering";
import { ubihealthdConfig } from "./ubihealthd-config";

export const patches = [r6sPacketSteering, odhcpdRaRestart, ubihealthdConfig, leasesToRam];

/** Last of every compile step: fixes layered over everything else. */
export const patchesFeature: FeatureModule = { compile: [{ order: 1000, compile: applyPatches(patches) }] };

/** Which patches each device gets, one line per device, for the CLI. */
export const describePatches = (intent: Intent) =>
  [
    "Patches over OpenWrt (src/intent/patches):",
    ...patchesFor(patches, intent).map(
      ({ device, patches }) =>
        `  ${device}: ${
          patches.map(({ id, only }) => (only ? `${id} (${only})` : id)).join(", ") || "none"
        }`
    ),
  ].join("\n");
